const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbPath = path.join(os.tmpdir(), `schedule-group-outbox-${process.pid}-${Date.now()}.json`);
process.env.DB_PATH = dbPath;
const { FileStore } = require('../server');

function patch(pathParts, before, after) {
  return {
    path: pathParts,
    before: before === undefined ? { exists: false } : { exists: true, value: before },
    after: after === undefined ? { exists: false } : { exists: true, value: after },
  };
}

test('release watch is atomically enqueued and a refill cancels it', async t => {
  t.after(() => {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}.tmp`, { force: true });
  });

  const week = '2026-10-26';
  const date = '2026-10-29';
  const key = `p1_${date}`;
  const original = [{ note: '原排班' }];
  const store = new FileStore({
    internalPeople: [{ id: 'p1', name: '阿文' }],
    weekPeople: { [week]: [{ id: 'p1', name: '阿文', _cat: 'internal' }] },
    schedules: { [week]: { g1: { [key]: original } } },
    timeOff: {},
  });
  await store.init();

  const removed = await store.applyPatch({
    mutationId: 'remove-once',
    changes: [patch(['schedules', week, 'g1', key], original, undefined)],
    historyEntries: [],
    releaseCandidates: [{
      trigger: 'release', week, personId: 'p1', personName: '阿文', date, actorName: '张雅镜',
    }],
  });
  assert.equal(removed.groupNotificationWake, true);
  assert.equal(store.groupNotificationOutbox.size, 1);
  const pending = [...store.groupNotificationOutbox.values()][0];
  assert.equal(pending.status, 'pending');

  const replacement = [{ note: '新排班' }];
  const refilled = await store.applyPatch({
    mutationId: 'refill-once',
    changes: [patch(['schedules', week, 'g1', key], undefined, replacement)],
    historyEntries: [],
    releaseCandidates: [{
      trigger: 'fill', week, personId: 'p1', personName: '阿文', date, actorName: '顺斌',
    }],
  });
  assert.equal(refilled.groupNotificationWake, false);
  assert.equal(pending.status, 'cancelled');
  assert.equal((await store.getState()).schedules[week].g1[key][0].note, '新排班');
});

test('startup requeues an interrupted group notification immediately', async () => {
  const store = new FileStore({});
  store.groupNotificationOutbox.set('gn-processing', {
    id: 'gn-processing', kind: 'released-slot', status: 'processing',
    availableAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  await store.requeueStaleGroupNotifications();
  assert.equal(store.groupNotificationOutbox.get('gn-processing').status, 'pending');
});
