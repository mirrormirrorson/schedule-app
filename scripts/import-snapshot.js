const fs = require('fs');
const path = require('path');

async function main() {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) {
    throw new Error('Usage: npm run import:snapshot -- <snapshot.json>');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const resolved = path.resolve(snapshotPath);
  const snapshot = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const { store } = require('../server');
  if (typeof store.importSnapshot !== 'function') {
    throw new Error('Snapshot import requires PostgreSQL storage');
  }
  await store.init();
  await store.importSnapshot(snapshot);
  const state = await store.getState();
  const history = await store.listHistory({ group: '', user: '', query: '', limit: 8000 });
  console.log(JSON.stringify({
    ok: true,
    revision: state._revision,
    updated: state._updated,
    history: history.length,
  }));
  await store.close();
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
