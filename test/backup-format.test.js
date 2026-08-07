const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { encryptBackup, decryptBackup } = require('../lib/backup-format');

test('encrypted backup round-trips and detects tampering', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const payload = {
    format: 'schedule-app-logical-backup-v1',
    createdAt: new Date().toISOString(),
    counts: { appState: 1, appUsers: 1, historyEntries: 1, mutations: 0 },
    tables: {
      appState: { revision: 9, data: { groups: [{ id: 'g1', name: '测试组' }] } },
      appUsers: [{ id: 'u1', name: '测试人员' }],
      historyEntries: [{ id: 'h1', data: { content: '测试内容' } }],
      mutations: [],
    },
  };
  const encrypted = encryptBackup(payload, publicKey);
  assert.deepEqual(decryptBackup(encrypted, privateKey).payload, payload);

  const envelope = JSON.parse(encrypted.toString('utf8'));
  const tampered = Buffer.from(envelope.ciphertext, 'base64');
  tampered[0] ^= 1;
  envelope.ciphertext = tampered.toString('base64');
  assert.throws(() => decryptBackup(Buffer.from(JSON.stringify(envelope)), privateKey));
});
