const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDailyVacancyPayload,
  formatDailyVacancyMessage,
  releaseCandidatesFromHistory,
  formatReleasedSlotMessage,
  GroupNotificationDispatcher,
} = require('../lib/group-schedule-notifier');

function sampleState() {
  return {
    internalPeople: [
      { id: 'p1', name: '阿文' },
      { id: 'p2', name: '顺斌' },
    ],
    weekPeople: {
      '2026-10-26': [
        { id: 'p1', name: '阿文', _cat: 'internal' },
        { id: 'p2', name: '顺斌', _cat: 'internal' },
        { id: 'e1', name: '外协', _cat: 'external' },
      ],
    },
    schedules: {
      '2026-10-26': {
        g1: {
          'p1_2026-10-29': [{ note: '已有排班' }],
          'p2_2026-10-30': [{ note: '已有排班' }],
        },
      },
    },
    timeOff: {
      '2026-10-26': {
        'p2_2026-10-29': { updatedBy: '测试' },
      },
    },
  };
}

test('09:00 summary includes remaining workdays only and excludes leave, weekends and external people', () => {
  const payload = buildDailyVacancyPayload(sampleState(), new Date('2026-10-29T01:00:00Z'));
  assert.equal(payload.runDate, '2026-10-29');
  assert.equal(payload.week, '2026-10-26');
  assert.deepEqual(payload.items.map(item => item.date), ['2026-10-30']);
  assert.deepEqual(payload.items[0].people.map(person => person.personName), ['阿文']);

  const message = formatDailyVacancyMessage(payload, 'https://schedule.example.com');
  assert.match(message.text, /10月30日 周五/);
  assert.match(message.text, /阿文/);
  assert.doesNotMatch(message.text, /周六/);
  assert.match(message.text, /休息日和已标记请假的老师不计入/);
});

test('delete and move-source produce release watches while later fills are cancellation candidates', () => {
  const candidates = releaseCandidatesFromHistory([
    { action: 'delete', week: '2026-10-26', personId: 'p1', person: '阿文', date: '2026-10-29', user: '张雅镜' },
    {
      action: 'move', week: '2026-10-26', user: '张雅镜',
      fromPersonId: 'p1', fromLabel: '阿文·周四', fromDate: '2026-10-29',
      toPersonId: 'p2', toLabel: '顺斌·周五', toDate: '2026-10-30',
    },
    { action: 'add', week: '2026-10-26', personId: 'p1', person: '阿文', date: '2026-10-29', user: '张雅镜' },
    { action: 'delete', week: '2026-11-02', personId: 'p1', person: '阿文', date: '2026-11-03', user: '张雅镜' },
  ], '2026-10-26');
  assert.deepEqual(candidates.map(item => [item.trigger, item.personId, item.date]), [
    ['release', 'p1', '2026-10-29'],
    ['release', 'p1', '2026-10-29'],
    ['fill', 'p2', '2026-10-30'],
    ['fill', 'p1', '2026-10-29'],
  ]);
});

test('released slot message names the teacher and date', () => {
  const message = formatReleasedSlotMessage({
    personName: '顺斌', date: '2026-10-31', actorName: '张雅镜',
  }, 'https://schedule.example.com');
  assert.match(message.text, /顺斌/);
  assert.match(message.text, /10月31日 周六/);
  assert.match(message.text, /2 分钟内仍未重新排上/);
  assert.match(message.text, /操作人：张雅镜/);
});

test('release dispatcher rechecks the cell before sending', async () => {
  const sent = [];
  const finished = [];
  let state = sampleState();
  delete state.schedules['2026-10-26'].g1['p1_2026-10-29'];
  const store = {
    requeueStaleGroupNotifications: async () => {},
    nextGroupNotificationAt: async () => null,
    claimDueGroupNotifications: async () => [{
      id: 'gn1', kind: 'released-slot', attempts: 0,
      payload: { week: '2026-10-26', personId: 'p1', personName: '阿文', date: '2026-10-29', actorName: '张雅镜' },
    }],
    getState: async () => state,
    finishGroupNotification: async (id, result) => finished.push({ id, ...result }),
  };
  const client = {
    configured: true,
    sendGroupMarkdown: async (...args) => sent.push(args),
  };
  const dispatcher = new GroupNotificationDispatcher({
    store, client, enabled: true, conversationId: 'cid-1', appUrl: '', currentWeek: () => '2026-10-26',
  });
  await dispatcher.flush();
  assert.equal(sent.length, 1);
  assert.equal(finished[0].status, 'sent');

  sent.length = 0;
  finished.length = 0;
  state.schedules['2026-10-26'].g1['p1_2026-10-29'] = [{ note: '补回排班' }];
  await dispatcher.flush();
  assert.equal(sent.length, 0);
  assert.equal(finished[0].status, 'skipped');
});
