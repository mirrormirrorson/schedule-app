const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH = require('node:path').join(
  require('node:os').tmpdir(),
  `schedule-health-${process.pid}-${Date.now()}.json`,
);

const { app, store } = require('../server');

test('health and ping use metadata without reading the full state', async t => {
  const originalGetState = store.getState;
  store.getState = async () => {
    throw new Error('full state must not be read by health probes');
  };

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    store.getState = originalGetState;
    await new Promise(resolve => server.close(resolve));
  });

  const { port } = server.address();
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  const healthPayload = await health.json();
  assert.equal(health.status, 200);
  assert.equal(healthPayload.ok, true);
  assert.equal(healthPayload.storage, 'file');
  assert.equal(Number.isFinite(healthPayload.revision), true);

  const ping = await fetch(`http://127.0.0.1:${port}/api/ping`);
  const pingPayload = await ping.json();
  assert.equal(ping.status, 200);
  assert.equal(Number.isFinite(pingPayload._revision), true);

  const history = await fetch(`http://127.0.0.1:${port}/api/history?limit=8000`);
  const historyTag = history.headers.get('etag');
  assert.equal(history.status, 200);
  assert.match(historyTag, /^W\/"history-[a-f0-9]{20}"$/);

  const unchangedHistory = await fetch(`http://127.0.0.1:${port}/api/history?limit=8000`, {
    headers: { 'If-None-Match': historyTag },
  });
  assert.equal(unchangedHistory.status, 304);
  assert.equal(await unchangedHistory.text(), '');
});
