const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbPath = path.join(os.tmpdir(), `schedule-file-restart-${process.pid}-${Date.now()}.json`);
process.env.DB_PATH = dbPath;
const { FileStore } = require('../server');

test('a committed patch survives a local service restart', async t => {
  t.after(() => {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}.tmp`, { force: true });
  });
  const seed = { groups: [], schedules: {}, resolutions: {} };
  const first = new FileStore(seed);
  await first.init();
  const before = { exists: false };
  const after = { exists: true, value: { verified: true } };
  const saved = await first.applyPatch({
    mutationId: 'restart-persistence-test',
    changes: [{ path: ['resolutions', 'local-restart-test'], before, after }],
    historyEntries: [{
      id: 'h_restart_test', opId: 'restart-test', ts: new Date().toISOString(),
      user: '本地测试', action: 'modify', content: '重启持久化测试',
    }],
  });
  assert.equal(saved.state.resolutions['local-restart-test'].verified, true);

  const disk = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const restarted = new FileStore(disk);
  assert.equal((await restarted.getState()).resolutions['local-restart-test'].verified, true);
  assert.equal((await restarted.listHistory({ group: '', user: '', query: '', limit: 10 })).length, 1);
});
