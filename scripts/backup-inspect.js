const fs = require('fs');
const path = require('path');
const { decryptBackup, sha256 } = require('../lib/backup-format');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const backupPath = process.argv[2] && path.resolve(process.argv[2]);
if (!backupPath) throw new Error('Usage: pnpm backup:inspect -- <backup.sab> [--extract output.json] [--private-key key.pem]');
const privatePath = path.resolve(
  argValue('--private-key')
    || process.env.BACKUP_PRIVATE_KEY_PATH
    || path.join(__dirname, '..', 'production-backups', 'keys', 'schedule-backup-private.pem'),
);
const encrypted = fs.readFileSync(backupPath);
const { envelope, payload } = decryptBackup(encrypted, fs.readFileSync(privatePath, 'utf8'));
const extractPath = argValue('--extract');
if (extractPath) {
  const resolved = path.resolve(extractPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });
}
console.log(JSON.stringify({
  ok: true,
  backup: backupPath,
  encryptedSha256: sha256(encrypted),
  createdAt: payload.createdAt,
  database: payload.source.database,
  revision: Number(payload.tables.appState && payload.tables.appState.revision || 0),
  counts: payload.counts,
  verifiedPayloadSha256: envelope.payloadSha256,
  extractedTo: extractPath ? path.resolve(extractPath) : null,
}, null, 2));
