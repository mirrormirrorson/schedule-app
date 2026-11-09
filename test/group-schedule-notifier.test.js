const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDailyVacancyPayload,
  formatDailyVacancyMessage,
  releaseCandidatesFromHistory,
  formatReleasedSlotMessage,
  GroupNotificationDispatcher,
  DailyVacancyScheduler,
  nextShanghaiNine,
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
  assert.match(message.text, /\[打开视频排班网页\]\(https:\/\/schedule\.example\.com\)/);
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
  assert.match(message.text, /5 分钟内仍未重新排上/);
  assert.match(message.text, /操作人：张雅镜/);
  assert.match(message.text, /\[打开视频排班网页\]\(https:\/\/schedule\.example\.com\)/);
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
    wasDailyVacancyAnnounced: async () => false,
    finishGroupNotification: async (id, result) => finished.push({ id, ...result }),
  };
  const client = {
    configured: true,
    sendGroupMarkdown: async (...args) => sent.push(args),
  };
  const dispatcher = new GroupNotificationDispatcher({
    store, client, enabled: true, conversationId: 'cid-1', appUrl: '',
    currentWeek: () => '2026-10-26', today: () => '2026-10-29',
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

test('release dispatcher suppresses past dates and cells already announced in the daily summary', async () => {
  const sent = [];
  const finished = [];
  const state = sampleState();
  delete state.schedules['2026-10-26'].g1['p1_2026-10-29'];
  const items = [
    {
      id: 'gn-past', kind: 'released-slot', attempts: 0,
      payload: { week: '2026-10-26', personId: 'p1', personName: '阿文', date: '2026-10-27' },
    },
    {
      id: 'gn-already-daily', kind: 'released-slot', attempts: 0,
      payload: { week: '2026-10-26', personId: 'p1', personName: '阿文', date: '2026-10-29' },
    },
  ];
  const store = {
    nextGroupNotificationAt: async () => null,
    claimDueGroupNotifications: async () => items,
    getState: async () => state,
    wasDailyVacancyAnnounced: async (runDate, personId, date) => (
      runDate === '2026-10-29' && personId === 'p1' && date === '2026-10-29'
    ),
    finishGroupNotification: async (id, result) => finished.push({ id, ...result }),
  };
  const dispatcher = new GroupNotificationDispatcher({
    store,
    client: { configured: true, sendGroupMarkdown: async (...args) => sent.push(args) },
    enabled: true,
    conversationId: 'cid-1',
    currentWeek: () => '2026-10-26',
    today: () => '2026-10-29',
  });

  await dispatcher.flush();

  assert.equal(sent.length, 0);
  assert.deepEqual(finished, [
    { id: 'gn-past', status: 'skipped', error: '日期已过去' },
    { id: 'gn-already-daily', status: 'skipped', error: '当天已在空余汇总中通知' },
  ]);
});

test('group dispatcher logs delivery failures with notification identity and retry state', async () => {
  const finished = [];
  const errors = [];
  const store = {
    requeueStaleGroupNotifications: async () => {},
    nextGroupNotificationAt: async () => null,
    claimDueGroupNotifications: async () => [{
      id: 'gn-failed-daily',
      kind: 'daily-vacancy',
      attempts: 0,
      payload: { runDate: '2026-11-09', items: [] },
    }],
    finishGroupNotification: async (id, result) => finished.push({ id, ...result }),
  };
  const client = {
    configured: true,
    sendGroupMarkdown: async () => { throw new Error('robot does not exist'); },
  };
  const logger = { error: (...args) => errors.push(args) };
  const dispatcher = new GroupNotificationDispatcher({
    store,
    client,
    enabled: true,
    conversationId: 'cid-1',
    appUrl: '',
    logger,
  });

  await dispatcher.flush();

  assert.equal(finished[0].status, 'pending');
  assert.equal(finished[0].error, 'robot does not exist');
  assert.deepEqual(errors, [[
    '[dingtalk-group-notify]',
    {
      id: 'gn-failed-daily',
      kind: 'daily-vacancy',
      attempt: 1,
      terminal: false,
      error: 'robot does not exist',
    },
  ]]);
});

test('daily scheduler enqueues once after 09:00 and schedules the next Shanghai morning', async () => {
  const enqueued = [];
  const wakeCalls = [];
  const timers = [];
  const now = new Date('2026-10-29T01:05:00Z');
  const store = {
    getState: async () => sampleState(),
    enqueueDailyGroupNotification: async payload => {
      enqueued.push(payload);
      return { inserted: true, empty: false };
    },
  };
  const dispatcher = { enabled: true, wake: delay => wakeCalls.push(delay) };
  const scheduler = new DailyVacancyScheduler({
    store,
    dispatcher,
    enabled: true,
    now: () => now,
    setTimeoutFn: (fn, delay) => {
      timers.push({ fn, delay });
      return { unref() {} };
    },
    clearTimeoutFn: () => {},
  });

  await scheduler.start();
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].runDate, '2026-10-29');
  assert.deepEqual(wakeCalls, [0]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 23 * 60 * 60 * 1000 + 55 * 60 * 1000);

  await scheduler.tick();
  assert.equal(enqueued.length, 1);
  scheduler.close();
});

test('daily scheduler waits until 09:00 Shanghai when started early', async () => {
  const timers = [];
  const now = new Date('2026-10-29T00:30:00Z');
  const scheduler = new DailyVacancyScheduler({
    store: {
      getState: async () => assert.fail('must not read state before 09:00'),
      enqueueDailyGroupNotification: async () => assert.fail('must not enqueue before 09:00'),
    },
    dispatcher: { enabled: true, wake() {} },
    enabled: true,
    now: () => now,
    setTimeoutFn: (fn, delay) => {
      timers.push({ fn, delay });
      return { unref() {} };
    },
    clearTimeoutFn: () => {},
  });

  await scheduler.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 30 * 60 * 1000);
  assert.equal(nextShanghaiNine(now).toISOString(), '2026-10-29T01:00:00.000Z');
  scheduler.close();
});
