const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-permissions-'));
process.env.DB_PATH = path.join(testDir, 'db.json');
delete process.env.DATABASE_URL;

const { app, store, scheduleWeekKeyForShanghai, futureScheduleWeeksFromChanges } = require('../server');

test.after(() => fs.rmSync(testDir, { recursive: true, force: true }));

test('schedule week boundary follows Shanghai time and flags only later cycles', () => {
  assert.equal(scheduleWeekKeyForShanghai(new Date('2026-08-11T04:00:00Z')), '2026-08-17');
  assert.equal(scheduleWeekKeyForShanghai(new Date('2026-08-16T04:00:00Z')), '2026-08-17');
  assert.equal(scheduleWeekKeyForShanghai(new Date('2026-08-17T04:00:00Z')), '2026-08-24');
  const changes = [
    { path: ['schedules', '2026-08-17', 'g1', 'p1_2026-08-17'], after: { exists: true, value: [{ note: '排班周' }] } },
    { path: ['schedules', '2026-08-24', 'g1', 'p1_2026-08-24'], after: { exists: true, value: [{ note: '未来周' }] } },
  ];
  assert.deepEqual(futureScheduleWeeksFromChanges(changes, '2026-08-17'), ['2026-08-24']);
});

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

test('only protected admins can write schedules after the scheduling week', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const identify = async name => (await jsonRequest(`${base}/api/user/identify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  })).payload.user;
  const admin = await identify('林俊凯');
  const regular = await identify('排班测试用户');
  const boundary = scheduleWeekKeyForShanghai();
  const future = new Date(boundary + 'T00:00:00Z');
  future.setUTCDate(future.getUTCDate() + 7);
  const futureWeek = future.toISOString().slice(0, 10);
  const changeFor = (week, note) => [{
    path: ['schedules', week, 'g_future_permission', `p_future_${week}`],
    before: { exists: false },
    after: { exists: true, value: [{ note }] },
  }];

  const before = await fetch(`${base}/api/state`).then(response => response.json());
  const allowedBoundary = await jsonRequest(`${base}/api/state/patch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mutationId: 'm_regular_schedule_boundary', changes: changeFor(boundary, '普通用户排班周'), actor: regular,
    }),
  });
  assert.equal(allowedBoundary.response.status, 200);
  assert.equal(allowedBoundary.payload.state._revision, before._revision + 1);

  const deniedFuture = await jsonRequest(`${base}/api/state/patch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mutationId: 'm_regular_schedule_future', changes: changeFor(futureWeek, '普通用户未来周'), actor: regular,
    }),
  });
  assert.equal(deniedFuture.response.status, 403);
  assert.equal(deniedFuture.payload.error, 'future schedule permission denied');
  assert.deepEqual(deniedFuture.payload.deniedWeeks, [futureWeek]);
  assert.equal(deniedFuture.payload.state._revision, allowedBoundary.payload.state._revision);

  const allowedAdmin = await jsonRequest(`${base}/api/state/patch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mutationId: 'm_admin_schedule_future', changes: changeFor(futureWeek, '管理员未来周'), actor: admin,
    }),
  });
  assert.equal(allowedAdmin.response.status, 200);
  assert.equal(allowedAdmin.payload.state.schedules[futureWeek].g_future_permission[`p_future_${futureWeek}`][0].note, '管理员未来周');
});

test('only protected admins can write global time off', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const identify = async name => (await jsonRequest(`${base}/api/user/identify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  })).payload.user;
  const admin = await identify('简慧仪');
  const regular = await identify('休假测试用户');
  const week = scheduleWeekKeyForShanghai();
  const cellKey = `person_time_off_${week}`;
  const change = [{
    path: ['timeOff', week, cellKey],
    before: { exists: false },
    after: { exists: true, value: { note: '年假' } },
  }];

  const denied = await jsonRequest(`${base}/api/state/patch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutationId: 'm_denied_time_off', changes: change, actor: regular }),
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error, 'time off permission denied');

  const allowed = await jsonRequest(`${base}/api/state/patch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutationId: 'm_allowed_time_off', changes: change, actor: admin }),
  });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.payload.state.timeOff[week][cellKey].note, '年假');
});
