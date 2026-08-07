const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { encryptBackup, sha256 } = require('../lib/backup-format');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function timestampName(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function loadPublicKey() {
  if (process.env.BACKUP_PUBLIC_KEY_B64) {
    return Buffer.from(process.env.BACKUP_PUBLIC_KEY_B64, 'base64').toString('utf8');
  }
  const keyPath = path.resolve(
    argValue('--public-key')
      || process.env.BACKUP_PUBLIC_KEY_PATH
      || path.join(__dirname, '..', 'production-backups', 'keys', 'schedule-backup-public.pem'),
  );
  return fs.readFileSync(keyPath, 'utf8');
}

async function readConsistentBackup(pool, databaseUrl) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const identity = await client.query('SELECT current_database() AS database_name');
    const state = await client.query('SELECT id, data, revision, updated_at FROM app_state WHERE id = 1');
    const users = await client.query(
      `SELECT name, id, first_seen_at, last_seen_at, can_score_radar, can_manage_radar_fields
       FROM app_users ORDER BY name ASC`,
    );
    const history = await client.query(
      `SELECT id, op_id, ts, user_name, week, group_name, person, action, content, data
       FROM history_entries ORDER BY ts ASC, id ASC`,
    );
    const mutations = await client.query(
      `SELECT id, revision, created_at FROM mutations
       WHERE created_at >= NOW() - INTERVAL '30 days'
       ORDER BY created_at ASC`,
    );
    await client.query('COMMIT');
    const parsed = new URL(databaseUrl);
    const createdAt = new Date().toISOString();
    const tables = {
      appState: state.rows[0] || null,
      appUsers: users.rows,
      historyEntries: history.rows,
      mutations: mutations.rows,
    };
    return {
      format: 'schedule-app-logical-backup-v1',
      createdAt,
      source: {
        database: identity.rows[0].database_name,
        hostFingerprint: sha256(parsed.hostname).slice(0, 16),
      },
      counts: {
        appState: tables.appState ? 1 : 0,
        appUsers: tables.appUsers.length,
        historyEntries: tables.historyEntries.length,
        mutations: tables.mutations.length,
      },
      tables,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const databaseUrl = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('BACKUP_DATABASE_URL or DATABASE_URL is required');
  const outputPath = path.resolve(
    argValue('--output')
      || path.join(__dirname, '..', 'production-backups', `schedule-backup-${timestampName()}.sab`),
  );
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 15000,
  });
  try {
    const payload = await readConsistentBackup(pool, databaseUrl);
    const encrypted = encryptBackup(payload, loadPublicKey());
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, encrypted, { flag: 'wx' });
    console.log(JSON.stringify({
      ok: true,
      output: outputPath,
      encryptedBytes: encrypted.length,
      sha256: sha256(encrypted),
      createdAt: payload.createdAt,
      revision: Number(payload.tables.appState && payload.tables.appState.revision || 0),
      counts: payload.counts,
    }));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { readConsistentBackup, timestampName };
