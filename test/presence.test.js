const test = require('node:test');
const assert = require('node:assert/strict');

const {
  app,
  normalizePresencePayload,
  prunePresence,
  getPresenceSnapshot,
  presenceSessions,
} = require('../server');

test.beforeEach(() => presenceSessions.clear());
test.after(() => presenceSessions.clear());

test('presence payload keeps location metadata but never arbitrary fields', () => {
  const payload = normalizePresencePayload({
    sessionId: 'p_alice_123456',
    active: true,
    userName: ' 张雅镜 ',
    context: {
      mode: 'overview',
      action: 'edit',
      weekStart: '2026-08-03',
      weekLabel: '8/3～8/9',
      groupId: 'g1',
      groupName: '臣妾组',
      personId: 'p1',
      personName: '阿文',
      dateStr: '2026-08-05',
      weekday: '周三',
      taskIndex: 1,
      note: '不应传输的排班内容',
    },
  });

  assert.equal(payload.userName, '张雅镜');
  assert.equal(payload.context.groupName, '臣妾组');
  assert.equal(payload.context.status, 'selected');
  assert.equal(payload.context.taskIndex, 1);
  assert.equal(Object.hasOwn(payload.context, 'note'), false);

  const onlineOnly = normalizePresencePayload({
    sessionId: 'p_online_123456', active: true, userName: '在线用户',
  });
  assert.equal(onlineOnly.context, null);
});

test('expired presence sessions are pruned from the snapshot', () => {
  presenceSessions.set('p_expired_1234', {
    sessionId: 'p_expired_1234',
    userName: '旧用户',
    context: {},
    lastSeen: 1,
  });
  presenceSessions.set('p_active_12345', {
    sessionId: 'p_active_12345',
    userName: '当前用户',
    context: {},
    lastSeen: 20_000,
  });

  prunePresence(20_000);
  assert.deepEqual(getPresenceSnapshot(20_000).map(item => item.userName), ['当前用户']);
});

test('presence API adds, lists and removes an active editor', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const activeResponse = await fetch(`${base}/api/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'p_editor_12345',
      active: true,
      userName: '张雅镜',
      context: {
        weekStart: '2026-08-03',
        weekLabel: '8/3～8/9',
        groupId: 'g1',
        groupName: '臣妾组',
        personId: 'p1',
        personName: '阿文',
        dateStr: '2026-08-05',
        weekday: '周三',
        taskIndex: 0,
      },
    }),
  });
  assert.equal(activeResponse.status, 200);
  const activePayload = await activeResponse.json();
  assert.equal(activePayload.editors.length, 1);
  assert.equal(activePayload.editors[0].context.personName, '阿文');

  const listPayload = await fetch(`${base}/api/presence`).then(response => response.json());
  assert.equal(listPayload.editors[0].userName, '张雅镜');

  const leavePayload = await fetch(`${base}/api/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'p_editor_12345', active: false }),
  }).then(response => response.json());
  assert.deepEqual(leavePayload.editors, []);
});

test('presence API rejects malformed session ids', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/api/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: '../bad', active: true, userName: '测试' }),
  });
  assert.equal(response.status, 400);
});
