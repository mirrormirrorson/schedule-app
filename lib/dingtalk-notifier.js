const crypto = require('crypto');

const SUPPORTED_ACTIONS = new Set(['add', 'modify', 'delete', 'move', 'leaveSet', 'leaveClear']);

function compactText(value, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function personNameFromLabel(label, fallback = '') {
  const value = compactText(label, 200);
  return value ? value.split('·')[0].trim() : compactText(fallback, 100);
}

function eventFromHistory(entry) {
  return {
    action: entry.action,
    week: compactText(entry.week, 20),
    group: compactText(entry.group, 100),
    date: compactText(entry.date, 20),
    weekday: compactText(entry.weekday, 20),
    content: compactText(entry.content, 500),
    fromLabel: compactText(entry.fromLabel, 200),
    toLabel: compactText(entry.toLabel, 200),
  };
}

function extractNotificationBatches({ mutationId, historyEntries, actorName, notifySelf = false }) {
  const grouped = new Map();
  const actor = compactText(actorName || (historyEntries || []).find(Boolean)?.user, 100) || '未知人员';

  function add(personId, personName, event) {
    const id = compactText(personId, 200);
    const name = compactText(personName, 100);
    if (!id || !name || (!notifySelf && name === actor)) return;
    if (!grouped.has(id)) grouped.set(id, { personId: id, personName: name, events: [] });
    const target = grouped.get(id);
    const fingerprint = JSON.stringify(event);
    if (!target.events.some(item => JSON.stringify(item) === fingerprint)) target.events.push(event);
  }

  for (const rawEntry of historyEntries || []) {
    const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : null;
    if (!entry || !SUPPORTED_ACTIONS.has(entry.action)) continue;
    const event = eventFromHistory(entry);
    if (entry.action === 'move') {
      add(entry.fromPersonId, personNameFromLabel(entry.fromLabel, entry.person), event);
      add(entry.toPersonId, personNameFromLabel(entry.toLabel, entry.person), event);
    } else {
      add(entry.personId, entry.person, event);
    }
  }

  return [...grouped.values()].map(batch => ({
    id: `dn_${crypto.createHash('sha256').update(`${mutationId}\0${batch.personId}`).digest('hex').slice(0, 32)}`,
    mutationId,
    personId: batch.personId,
    personName: batch.personName,
    actorName: actor,
    events: batch.events,
  }));
}

function actionLabel(action) {
  return ({
    add: '新增排班',
    modify: '修改排班',
    delete: '删除排班',
    move: '移动排班',
    leaveSet: '标记请假',
    leaveClear: '取消请假',
  })[action] || '更新排班';
}

function formatEvent(event) {
  if (event.action === 'move') {
    return `• ${actionLabel(event.action)}：${event.fromLabel || '原位置'} → ${event.toLabel || '新位置'}${event.content ? `（${event.content}）` : ''}`;
  }
  const where = [event.date, event.weekday, event.group].filter(Boolean).join(' · ');
  const content = event.action === 'leaveSet'
    ? '请假'
    : event.action === 'leaveClear'
      ? '恢复排班'
      : event.content;
  return `• ${where ? `${where}：` : ''}${actionLabel(event.action)}${content ? `「${content}」` : ''}`;
}

function formatPrivateMessage(batch, appUrl) {
  const events = (batch.events || []).slice(0, 10);
  const omitted = Math.max(0, (batch.events || []).length - events.length);
  return [
    '【视频排班有更新】',
    `${batch.personName}老师，您的排班刚刚有变更：`,
    ...events.map(formatEvent),
    omitted ? `• 另有 ${omitted} 项变更，请打开网页查看` : '',
    `操作人：${batch.actorName || '未知人员'}`,
    appUrl ? `查看排班：${appUrl}` : '',
  ].filter(Boolean).join('\n');
}

class DingTalkClient {
  constructor({ clientId, clientSecret, robotCode, fetchImpl = global.fetch, timeoutMs = 10_000 }) {
    this.clientId = String(clientId || '').trim();
    this.clientSecret = String(clientSecret || '').trim();
    this.robotCode = String(robotCode || '').trim();
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret && this.robotCode && this.fetch);
  }

  async request(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, { ...options, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = payload.message || payload.errmsg || `HTTP ${response.status}`;
        throw new Error(message);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async accessToken() {
    if (!this.configured) throw new Error('DingTalk credentials are not configured');
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const payload = await this.request('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret }),
    });
    if (!payload.accessToken) throw new Error('DingTalk access token missing');
    this.token = payload.accessToken;
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(payload.expireIn || 7200) - 300) * 1000;
    return this.token;
  }

  async sendPrivateText(dingtalkUserId, content) {
    const token = await this.accessToken();
    return this.request('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({
        robotCode: this.robotCode,
        userIds: [dingtalkUserId],
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content }),
      }),
    });
  }
}

class NotificationDispatcher {
  constructor({ store, client, enabled, appUrl, logger = console }) {
    this.store = store;
    this.client = client;
    this.enabled = enabled === true && client.configured;
    this.appUrl = String(appUrl || '').replace(/\/$/, '');
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  async start() {
    if (!this.enabled) return;
    await this.store.requeueStaleNotifications();
    await this.scheduleNext();
  }

  wake(delayMs = 0) {
    if (!this.enabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(error => this.logger.error('[dingtalk-notify]', error)), Math.max(0, delayMs));
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async scheduleNext() {
    if (!this.enabled) return;
    const nextAt = await this.store.nextNotificationAt();
    if (nextAt) this.wake(Math.max(0, new Date(nextAt).getTime() - Date.now()));
  }

  async flush() {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const batches = await this.store.claimDueNotifications(50);
      const grouped = new Map();
      for (const batch of batches) {
        if (!grouped.has(batch.personId)) grouped.set(batch.personId, []);
        grouped.get(batch.personId).push(batch);
      }
      for (const personBatches of grouped.values()) {
        const first = personBatches[0];
        const binding = await this.store.getDingTalkBinding(first.personId);
        if (!binding || binding.enabled !== true) {
          await Promise.all(personBatches.map(batch => this.store.finishNotification(
            batch.id,
            { status: 'skipped', error: '未绑定钉钉账号' },
          )));
          continue;
        }
        const merged = {
          personId: first.personId,
          personName: first.personName,
          actorName: [...new Set(personBatches.map(item => item.actorName).filter(Boolean))].join('、'),
          events: personBatches.flatMap(item => item.events || []),
        };
        try {
          await this.client.sendPrivateText(binding.dingtalkUserId, formatPrivateMessage(merged, this.appUrl));
          await Promise.all(personBatches.map(batch => this.store.finishNotification(batch.id, { status: 'sent' })));
        } catch (error) {
          const attempts = Math.max(...personBatches.map(batch => Number(batch.attempts || 0))) + 1;
          const retryMs = [60_000, 5 * 60_000, 15 * 60_000][Math.min(attempts - 1, 2)];
          const result = {
            status: attempts >= 3 ? 'failed' : 'pending',
            error: compactText(error && error.message, 500),
            retryAt: attempts >= 3 ? null : new Date(Date.now() + retryMs).toISOString(),
          };
          await Promise.all(personBatches.map(batch => this.store.finishNotification(batch.id, result)));
        }
      }
    } finally {
      this.running = false;
      await this.scheduleNext();
    }
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = {
  extractNotificationBatches,
  formatPrivateMessage,
  DingTalkClient,
  NotificationDispatcher,
};
