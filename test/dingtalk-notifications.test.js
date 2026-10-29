const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractNotificationBatches,
  formatPrivateMessage,
  DingTalkClient,
  NotificationDispatcher,
} = require('../lib/dingtalk-notifier');

test('schedule history becomes one private notification batch per affected person', () => {
  const batches = extractNotificationBatches({
    mutationId: 'mutation-001',
    actorName: '张雅镜',
    targetWeek: '2026-11-02',
    historyEntries: [
      {
        action: 'add', personId: 'p1', person: '阿文', user: '张雅镜',
        week: '2026-11-02', date: '2026-11-03', weekday: '周二', group: '未来组', content: '淘金币-剪1',
      },
      {
        action: 'modify', personId: 'p1', person: '阿文', user: '张雅镜',
        week: '2026-11-02', date: '2026-11-04', weekday: '周三', group: '未来组', content: '淘金币-剪2',
      },
      { action: 'add', personId: 'admin', person: '张雅镜', user: '张雅镜', content: '本人操作' },
    ],
  });

  assert.equal(batches.length, 1);
  assert.equal(batches[0].personId, 'p1');
  assert.equal(batches[0].personName, '阿文');
  assert.equal(batches[0].events.length, 2);
  assert.match(batches[0].id, /^dn_[a-f0-9]{32}$/);
});

test('moving across people notifies both source and destination rows', () => {
  const batches = extractNotificationBatches({
    mutationId: 'mutation-002',
    actorName: '简慧仪',
    notifySelf: true,
    targetWeek: '2026-11-02',
    historyEntries: [{
      action: 'move', user: '简慧仪', group: '臣妾组', content: '蓝花火-剪1',
      week: '2026-11-02',
      fromPersonId: 'p1', fromLabel: '阿文·周一', fromDate: '2026-11-02',
      toPersonId: 'p2', toLabel: '顺斌·周二', toDate: '2026-11-03',
    }],
  });
  assert.deepEqual(batches.map(item => item.personName).sort(), ['阿文', '顺斌']);
  assert.ok(batches.every(item => item.events[0].action === 'move'));
});

test('only current-week history becomes a private notification', () => {
  const batches = extractNotificationBatches({
    mutationId: 'mutation-current-week-only',
    actorName: '张雅镜',
    targetWeek: '2026-10-26',
    historyEntries: [
      {
        action: 'modify', personId: 'p1', person: '阿文', user: '张雅镜',
        week: '2026-10-26', date: '2026-10-28', weekday: '周三', group: '未来组', content: '本周临时修改',
      },
      {
        action: 'modify', personId: 'p1', person: '阿文', user: '张雅镜',
        week: '2026-11-02', date: '2026-11-03', weekday: '周二', group: '未来组', content: '排班周正常调整',
      },
    ],
  });

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].events.map(event => event.content), ['本周临时修改']);
});

test('private message contains teacher, change details, actor and site link', () => {
  const message = formatPrivateMessage({
    personName: '阿文', actorName: '张雅镜',
    events: [{ action: 'add', date: '2026-11-03', weekday: '周二', group: '未来组', content: '淘金币-剪1' }],
  }, 'https://schedule.example.com');
  assert.match(message, /阿文老师/);
  assert.match(message, /新增排班/);
  assert.match(message, /操作人：张雅镜/);
  assert.match(message, /https:\/\/schedule\.example\.com/);
  assert.match(message, /【变更 1】\n日期：2026-11-03（周二）\n小组：未来组\n类型：新增排班\n内容：\n淘金币-剪1/);
});

test('private message preserves line breaks inside schedule content', () => {
  const batches = extractNotificationBatches({
    mutationId: 'mutation-multiline-content',
    actorName: '张雅镜',
    targetWeek: '2026-10-26',
    historyEntries: [{
      action: 'add', personId: 'p1', person: '顺斌（曾顺斌）', user: '张雅镜',
      week: '2026-10-26', date: '2026-10-31', weekday: '周六', group: '未来组',
      content: '这是一条测试排班\n对接：镜子',
    }],
  });
  const message = formatPrivateMessage(batches[0], 'https://schedule.example.com');
  assert.match(message, /顺斌（曾顺斌）老师，您的本周排班有临时变更/);
  assert.match(message, /内容：\n这是一条测试排班\n对接：镜子/);
  assert.match(message, /\n\n操作人：张雅镜\n查看排班：/);
});

test('DingTalk client gets an app token and uses the private robot endpoint', async () => {
  const calls = [];
  const client = new DingTalkClient({
    clientId: 'app-key', clientSecret: 'app-secret', robotCode: 'robot-code',
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        json: async () => url.includes('accessToken') ? { accessToken: 'token-1', expireIn: 7200 } : { processQueryKey: 'query-1' },
      };
    },
  });

  await client.sendPrivateText('user-123', '测试私信');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.dingtalk.com/v1.0/oauth2/accessToken');
  assert.deepEqual(calls[0].body, { appKey: 'app-key', appSecret: 'app-secret' });
  assert.equal(calls[1].url, 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend');
  assert.equal(calls[1].options.headers['x-acs-dingtalk-access-token'], 'token-1');
  assert.deepEqual(calls[1].body.userIds, ['user-123']);
  assert.equal(calls[1].body.robotCode, 'robot-code');
  assert.deepEqual(JSON.parse(calls[1].body.msgParam), { content: '测试私信' });
});

test('DingTalk client sends Markdown through the enterprise group robot endpoint', async () => {
  const calls = [];
  const client = new DingTalkClient({
    clientId: 'app-key', clientSecret: 'app-secret', robotCode: 'robot-code',
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        json: async () => url.includes('accessToken') ? { accessToken: 'token-1', expireIn: 7200 } : { processQueryKey: 'query-2' },
      };
    },
  });

  await client.sendGroupMarkdown('cid-123', '空余排期提醒', '## 空余排期提醒\n\n- 周一：阿文');
  assert.equal(calls[1].url, 'https://api.dingtalk.com/v1.0/robot/groupMessages/send');
  assert.equal(calls[1].body.openConversationId, 'cid-123');
  assert.equal(calls[1].body.robotCode, 'robot-code');
  assert.equal(calls[1].body.msgKey, 'sampleMarkdown');
  assert.deepEqual(JSON.parse(calls[1].body.msgParam), {
    title: '空余排期提醒',
    text: '## 空余排期提醒\n\n- 周一：阿文',
  });
});

test('dispatcher merges due changes for the same teacher into one private message', async () => {
  const finished = [];
  const sent = [];
  const store = {
    claimDueNotifications: async () => [
      { id: 'n1', personId: 'p1', personName: '阿文', actorName: '张雅镜', attempts: 0, events: [{ action: 'add', content: '任务一' }] },
      { id: 'n2', personId: 'p1', personName: '阿文', actorName: '简慧仪', attempts: 0, events: [{ action: 'modify', content: '任务二' }] },
    ],
    getDingTalkBinding: async () => ({ enabled: true, dingtalkUserId: 'user-1' }),
    finishNotification: async (id, result) => finished.push({ id, ...result }),
    nextNotificationAt: async () => null,
  };
  const client = {
    configured: true,
    sendPrivateText: async (userId, message) => sent.push({ userId, message }),
  };
  const dispatcher = new NotificationDispatcher({ store, client, enabled: true, appUrl: 'https://schedule.example.com' });
  await dispatcher.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, 'user-1');
  assert.match(sent[0].message, /任务一/);
  assert.match(sent[0].message, /任务二/);
  assert.deepEqual(finished.map(item => [item.id, item.status]), [['n1', 'sent'], ['n2', 'sent']]);
});
