const fs = require('fs');
const path = require('path');
const { BACKUP_FORMAT, loadBackup, sha256 } = require('../lib/backup-format');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const backupPath = process.argv[2] && path.resolve(process.argv[2]);
if (!backupPath) throw new Error('Usage: pnpm backup:inspect -- <backup.json|backup.sab> [--extract output.json] [--private-key key.pem]');
const raw = fs.readFileSync(backupPath);
const parsed = JSON.parse(raw.toString('utf8'));
let privateKey = '';
if (parsed.format === BACKUP_FORMAT) {
  const privatePath = path.resolve(
    argValue('--private-key')
      || process.env.BACKUP_PRIVATE_KEY_PATH
      || path.join(__dirname, '..', 'production-backups', 'keys', 'schedule-backup-private.pem'),
  );
  privateKey = fs.readFileSync(privatePath, 'utf8');
}
const { encrypted, envelope, payload } = loadBackup(raw, privateKey);
const extractPath = argValue('--extract');
if (extractPath) {
  const resolved = path.resolve(extractPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });
}
console.log(JSON.stringify({
  ok: true,
  backup: backupPath,
  format: encrypted ? 'encrypted' : 'plain-json',
  backupSha256: sha256(raw),
  createdAt: payload.createdAt,
  database: payload.source.database,
  revision: Number(payload.tables.appState && payload.tables.appState.revision || 0),
  counts: payload.counts,
  verifiedPayloadSha256: envelope
    ? envelope.payloadSha256
    : sha256(Buffer.from(JSON.stringify(payload), 'utf8')),
  extractedTo: extractPath ? path.resolve(extractPath) : null,
}, null, 2));
