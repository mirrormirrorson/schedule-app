const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-permissions-'));
process.env.DB_PATH = path.join(testDir, 'db.json');
delete process.env.DATABASE_URL;

const { app, store } = require('../server');

test.after(() => fs.rmSync(testDir, { recursive: true, force: true }));

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  return { response, payload: await response.json() };
}

test('protected admins manage account permissions while regular users cannot', async t => {
  await store.init();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const identify = name => jsonRequest(`${base}/api/user/identify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const admin = (await identify('简慧仪')).payload.user;
  const regular = (await identify('普通用户')).payload.user;
  assert.equal(admin.isPermissionAdmin, true);
  assert.deepEqual(admin.permissions, { canScoreRadar: true, canManageRadarFields: true });
  assert.deepEqual(regular.permissions, { canScoreRadar: false, canManageRadarFields: false });

  const deniedList = await jsonRequest(
    `${base}/api/admin/users?actorId=${encodeURIComponent(regular.id)}&actorName=${encodeURIComponent(regular.name)}`,
  );
  assert.equal(deniedList.response.status, 403);

  const allowedList = await jsonRequest(
    `${base}/api/admin/users?actorId=${encodeURIComponent(admin.id)}&actorName=${encodeURIComponent(admin.name)}`,
  );
  assert.equal(allowedList.response.status, 200);
  assert.equal(allowedList.payload.users.length, 2);

  const updated = await jsonRequest(`${base}/api/admin/users/${regular.id}/permissions`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actor: { id: admin.id, name: admin.name },
      permissions: { canScoreRadar: true, canManageRadarFields: false },
    }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.user.permissions.canScoreRadar, true);
  assert.equal(updated.payload.user.permissions.canManageRadarFields, false);

  const protectedDelete = await jsonRequest(`${base}/api/admin/users/${admin.id}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor: { id: admin.id, name: admin.name } }),
  });
  assert.equal(protectedDelete.response.status, 409);

  const deleted = await jsonRequest(`${base}/api/admin/users/${regular.id}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor: { id: admin.id, name: admin.name } }),
  });
  assert.equal(deleted.response.status, 200);
});

test('server rejects radar patches without the matching account capability', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const identify = async name => (await jsonRequest(`${base}/api/user/identify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  })).payload.user;
  const admin = await identify('张雅镜');
  const regular = await identify('评分测试用户');
  const state = await fetch(`${base}/api/state`).then(response => response.json());
  const scoreChange = [{
    path: ['personRadarScores', 'p1'],
    before: { exists: false },
    after: { exists: true, value: { rf1: 8 } },
  }];

  const denied = await jsonRequest(`${base}/api/state/patch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutationId: 'm_denied_score_1', changes: scoreChange, actor: regular }),
  });
  assert.equal(denied.response.status, 403);
  assert.deepEqual(denied.payload.deniedRoots, ['personRadarScores']);
  assert.deepEqual(denied.payload.user.permissions, {
    canScoreRadar: false,
    canManageRadarFields: false,
  });

  await jsonRequest(`${base}/api/admin/users/${regular.id}/permissions`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actor: admin,
      permissions: { canScoreRadar: true, canManageRadarFields: false },
    }),
  });
  const refreshed = await identify('评分测试用户');
  const allowed = await jsonRequest(`${base}/api/state/patch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutationId: 'm_allowed_score_1', changes: scoreChange, actor: refreshed }),
  });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.payload.state.personRadarScores.p1.rf1, 8);
  assert.equal(state._revision + 1, allowed.payload.state._revision);

  const existingFields = allowed.payload.state.personRadarFields || [];
  const fieldChange = [{
    path: ['personRadarFields'],
    before: { exists: true, value: existingFields },
    after: { exists: true, value: [...existingFields, { id: 'rf_permission_test', name: '权限测试' }] },
  }];
  const deniedField = await jsonRequest(`${base}/api/state/patch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutationId: 'm_denied_field_1', changes: fieldChange, actor: refreshed }),
  });
  assert.equal(deniedField.response.status, 403);
  assert.deepEqual(deniedField.payload.deniedRoots, ['personRadarFields']);

  await jsonRequest(`${base}/api/admin/users/${regular.id}/permissions`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actor: admin,
      permissions: { canScoreRadar: true, canManageRadarFields: true },
    }),
  });
  const fullyAuthorized = await identify('评分测试用户');
  const allowedField = await jsonRequest(`${base}/api/state/patch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutationId: 'm_allowed_field_1', changes: fieldChange, actor: fullyAuthorized }),
  });
  assert.equal(allowedField.response.status, 200);
  assert.equal(allowedField.payload.state.personRadarFields.at(-1).name, '权限测试');
});
