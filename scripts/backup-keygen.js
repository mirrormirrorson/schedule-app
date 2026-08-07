const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const outputArgument = process.argv.slice(2).find(value => !value.startsWith('--'));
const outputDir = path.resolve(outputArgument || path.join(__dirname, '..', 'production-backups', 'keys'));
const privatePath = path.join(outputDir, 'schedule-backup-private.pem');
const publicPath = path.join(outputDir, 'schedule-backup-public.pem');

if (fs.existsSync(privatePath) || fs.existsSync(publicPath)) {
  throw new Error(`Backup key already exists in ${outputDir}; refusing to overwrite it.`);
}

fs.mkdirSync(outputDir, { recursive: true });
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
fs.writeFileSync(privatePath, privateKey, { encoding: 'utf8', mode: 0o600 });
fs.writeFileSync(publicPath, publicKey, 'utf8');

const result = {
  ok: true,
  privateKey: privatePath,
  publicKey: publicPath,
  githubVariable: 'BACKUP_PUBLIC_KEY_B64',
};
if (!process.argv.includes('--quiet')) {
  result.githubVariableValue = Buffer.from(publicKey, 'utf8').toString('base64');
}
console.log(JSON.stringify(result, null, 2));
