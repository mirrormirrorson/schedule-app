const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { decryptBackup } = require('../lib/backup-format');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

async function main() {
  const backupPath = process.argv[2] && path.resolve(process.argv[2]);
  const databaseUrl = process.env.RESTORE_DATABASE_URL;
  const expectedDatabase = argValue('--confirm-database');
  const apply = process.argv.includes('--apply');
  if (!backupPath) throw new Error('Backup path is required');
  const privatePath = path.resolve(
    argValue('--private-key')
      || process.env.BACKUP_PRIVATE_KEY_PATH
      || path.join(__dirname, '..', 'production-backups', 'keys', 'schedule-backup-private.pem'),
  );
  const { payload } = decryptBackup(
    fs.readFileSync(backupPath),
    fs.readFileSync(privatePath, 'utf8'),
  );
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'verify-only',
      createdAt: payload.createdAt,
      revision: Number(payload.tables.appState && payload.tables.appState.revision || 0),
      counts: payload.counts,
      next: 'Use RESTORE_DATABASE_URL plus --apply --confirm-database <exact-name> only on the intended recovery database.',
    }, null, 2));
    return;
  }
  if (!databaseUrl || !expectedDatabase) {
    throw new Error('RESTORE_DATABASE_URL and --confirm-database are required for --apply');
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 1,
  });
  const client = await pool.connect();
  try {
    const identity = await client.query('SELECT current_database() AS database_name');
    const actualDatabase = identity.rows[0].database_name;
    if (actualDatabase !== expectedDatabase) {
      throw new Error(`Target database mismatch: expected ${expectedDatabase}, got ${actualDatabase}`);
    }
    const schema = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_init.sql'), 'utf8');
    await client.query(schema);
    const existing = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM app_state) AS state_count,
         (SELECT COUNT(*)::int FROM app_users) AS user_count,
         (SELECT COUNT(*)::int FROM history_entries) AS history_count`,
    );
    const counts = existing.rows[0];
    const nonEmpty = counts.state_count || counts.user_count || counts.history_count;
    if (nonEmpty && process.env.RESTORE_ALLOW_NONEMPTY !== 'yes') {
      throw new Error('Target is not empty; set RESTORE_ALLOW_NONEMPTY=yes only after a separate safety backup.');
    }

    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('DELETE FROM mutations');
    await client.query('DELETE FROM history_entries');
    await client.query('DELETE FROM app_users');
    await client.query('DELETE FROM app_state');
    const state = payload.tables.appState;
    if (state) {
      await client.query(
        'INSERT INTO app_state (id, data, revision, updated_at) VALUES (1, $1::jsonb, $2, $3)',
        [JSON.stringify(state.data), Number(state.revision), state.updated_at],
      );
    }
    for (const user of payload.tables.appUsers || []) {
      await client.query(
        `INSERT INTO app_users
           (name, id, first_seen_at, last_seen_at, can_score_radar, can_manage_radar_fields)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.name, user.id, user.first_seen_at, user.last_seen_at, user.can_score_radar, user.can_manage_radar_fields],
      );
    }
    for (const entry of payload.tables.historyEntries || []) {
      await client.query(
        `INSERT INTO history_entries
           (id, op_id, ts, user_name, week, group_name, person, action, content, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [entry.id, entry.op_id, entry.ts, entry.user_name, entry.week, entry.group_name,
          entry.person, entry.action, entry.content, JSON.stringify(entry.data)],
      );
    }
    for (const mutation of payload.tables.mutations || []) {
      await client.query(
        'INSERT INTO mutations (id, revision, created_at) VALUES ($1, $2, $3)',
        [mutation.id, Number(mutation.revision), mutation.created_at],
      );
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, restoredDatabase: actualDatabase, counts: payload.counts }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
