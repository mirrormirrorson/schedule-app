const crypto = require('crypto');
const zlib = require('zlib');

const BACKUP_FORMAT = 'schedule-app-encrypted-backup-v1';
const PLAIN_BACKUP_FORMAT = 'schedule-app-logical-backup-v1';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encryptBackup(payload, publicKey) {
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  const compressed = zlib.gzipSync(plain, { level: 9 });
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const wrappedKey = crypto.publicEncrypt({
    key: publicKey,
    oaepHash: 'sha256',
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
  }, dataKey);

  const envelope = {
    format: BACKUP_FORMAT,
    createdAt: payload.createdAt,
    algorithm: 'RSA-OAEP-SHA256+AES-256-GCM+GZIP',
    payloadSha256: sha256(plain),
    plainBytes: plain.length,
    compressedBytes: compressed.length,
    wrappedKey: wrappedKey.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
}

function decryptBackup(encrypted, privateKey) {
  const envelope = JSON.parse(Buffer.isBuffer(encrypted) ? encrypted.toString('utf8') : String(encrypted));
  if (envelope.format !== BACKUP_FORMAT) throw new Error('Unsupported backup format');
  const dataKey = crypto.privateDecrypt({
    key: privateKey,
    oaepHash: 'sha256',
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
  }, Buffer.from(envelope.wrappedKey, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const compressed = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  const plain = zlib.gunzipSync(compressed);
  if (sha256(plain) !== envelope.payloadSha256) throw new Error('Backup checksum mismatch');
  return { envelope, payload: JSON.parse(plain.toString('utf8')) };
}

function serializePlainBackup(payload) {
  if (!payload || payload.format !== PLAIN_BACKUP_FORMAT) {
    throw new Error('Unsupported logical backup payload');
  }
  return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function loadBackup(value, privateKey = '') {
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const parsed = JSON.parse(raw.toString('utf8'));
  if (parsed.format === PLAIN_BACKUP_FORMAT) {
    return { encrypted: false, envelope: null, payload: parsed };
  }
  if (parsed.format === BACKUP_FORMAT) {
    if (!privateKey) throw new Error('Private key is required for an encrypted backup');
    return { encrypted: true, ...decryptBackup(raw, privateKey) };
  }
  throw new Error('Unsupported backup format');
}

module.exports = {
  BACKUP_FORMAT,
  PLAIN_BACKUP_FORMAT,
  sha256,
  encryptBackup,
  decryptBackup,
  serializePlainBackup,
  loadBackup,
};
