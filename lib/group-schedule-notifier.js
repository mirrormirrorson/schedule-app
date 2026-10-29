const crypto = require('crypto');
const WorkCalendar = require('../public/js/work-calendar');

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function compactText(value, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function shanghaiParts(now = new Date()) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: SHANGHAI_TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]),
  );
}

function shanghaiDateKey(now = new Date()) {
  const parts = shanghaiParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function mondayKeyForDate(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function internalPeopleForWeek(state, week) {
  const snapshot = Array.isArray(state && state.weekPeople && state.weekPeople[week])
    ? state.weekPeople[week]
    : [];
  const people = snapshot.length ? snapshot : (state && state.internalPeople) || [];
  return people.filter(person => person && person.id && person._cat !== 'external');
}

function scheduleEntriesForCell(state, week, personId, date) {
  const groups = state && state.schedules && state.schedules[week];
  if (!groups || typeof groups !== 'object') return [];
  const key = `${personId}_${date}`;
  return Object.values(groups).flatMap(group => {
    const entries = group && group[key];
    return Array.isArray(entries) ? entries.filter(Boolean) : [];
  });
}

function hasTimeOff(state, week, personId, date) {
  return Boolean(state && state.timeOff && state.timeOff[week] && state.timeOff[week][`${personId}_${date}`]);
}

function isCellVacant(state, week, personId, date) {
  return !hasTimeOff(state, week, personId, date)
    && scheduleEntriesForCell(state, week, personId, date).length === 0;
}

function displayDate(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  return `${Number(dateKey.slice(5, 7))}月${Number(dateKey.slice(8, 10))}日 ${WEEKDAY_NAMES[date.getUTCDay()]}`;
}

function buildDailyVacancyPayload(state, now = new Date()) {
  const today = shanghaiDateKey(now);
  const week = mondayKeyForDate(today);
  const people = internalPeopleForWeek(state, week);
  const items = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(week, offset);
    if (date < today || WorkCalendar.getDayInfo(date).kind !== 'work') continue;
    const vacant = people
      .filter(person => isCellVacant(state, week, person.id, date))
      .map(person => ({ personId: person.id, personName: compactText(person.name, 100) }));
    if (vacant.length) items.push({ date, weekday: displayDate(date), people: vacant });
  }
  return { kind: 'daily-vacancy', runDate: today, week, items };
}

function formatDailyVacancyMessage(payload, appUrl = '') {
  const lines = [
    '## 本周空余排期提醒',
    '',
    `截至 ${displayDate(payload.runDate)} 09:00，以下工作日仍有空余排期：`,
    '',
  ];
  for (const item of payload.items || []) {
    lines.push(`- **${item.weekday}**：${item.people.map(person => person.personName).join('、')}`);
  }
  lines.push('', '休息日和已标记请假的老师不计入空余名单。');
  if (appUrl) lines.push('', `[打开视频排班网页](${appUrl})`);
  return { title: '本周空余排期提醒', text: lines.join('\n') };
}

function releaseCandidatesFromHistory(historyEntries, targetWeek) {
  const candidates = [];
  function add(source, trigger) {
    const week = compactText(source.week, 20);
    const personId = compactText(source.personId, 200);
    const date = compactText(source.date, 20);
    if (!personId || !date || (targetWeek && week !== targetWeek)) return;
    candidates.push({
      trigger, week, personId, date,
      personName: compactText(source.personName || source.person, 100),
      actorName: compactText(source.actorName || source.user, 100),
    });
  }
  for (const entry of historyEntries || []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.action === 'delete') add(entry, 'release');
    else if (entry.action === 'move') {
      add({ ...entry, personId: entry.fromPersonId, personName: String(entry.fromLabel || '').split('·')[0], date: entry.fromDate }, 'release');
      add({ ...entry, personId: entry.toPersonId, personName: String(entry.toLabel || '').split('·')[0], date: entry.toDate }, 'fill');
    } else if (['add', 'modify', 'leaveSet'].includes(entry.action)) add(entry, 'fill');
  }
  return candidates;
}

function releaseNotificationFromCandidate(candidate, mutationId, now = new Date()) {
  const hash = crypto.createHash('sha256')
    .update(`${mutationId}\0${candidate.week}\0${candidate.personId}\0${candidate.date}`)
    .digest('hex').slice(0, 32);
  return {
    id: `gn_${hash}`,
    dedupeKey: `release:${mutationId}:${candidate.personId}:${candidate.date}`,
    kind: 'released-slot',
    payload: { ...candidate, detectedAt: now.toISOString() },
  };
}

function formatReleasedSlotMessage(payload, appUrl = '') {
  const lines = [
    '## 排班空位释放提醒',
    '',
    `**${payload.personName}** 老师的 **${displayDate(payload.date)}** 排期已释放。`,
    '',
    '该空位在删除后 2 分钟内仍未重新排上，请有需要的同事及时协调。',
  ];
  if (payload.actorName) lines.push('', `操作人：${payload.actorName}`);
  if (appUrl) lines.push('', `[打开视频排班网页](${appUrl})`);
  return { title: '排班空位释放提醒', text: lines.join('\n') };
}

class GroupNotificationDispatcher {
  constructor({ store, client, enabled, conversationId, appUrl, logger = console, currentWeek }) {
    this.store = store;
    this.client = client;
    this.enabled = enabled === true && client.configured && Boolean(String(conversationId || '').trim());
    this.conversationId = String(conversationId || '').trim();
    this.appUrl = String(appUrl || '').replace(/\/$/, '');
    this.logger = logger;
    this.currentWeek = currentWeek || (() => mondayKeyForDate(shanghaiDateKey()));
    this.timer = null;
    this.running = false;
  }

  async start() {
    if (!this.enabled) return;
    await this.store.requeueStaleGroupNotifications();
    await this.scheduleNext();
  }

  wake(delayMs = 0) {
    if (!this.enabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(error => this.logger.error('[dingtalk-group-notify]', error)), Math.max(0, delayMs));
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async scheduleNext() {
    if (!this.enabled) return;
    const nextAt = await this.store.nextGroupNotificationAt();
    if (nextAt) this.wake(Math.max(0, new Date(nextAt).getTime() - Date.now()));
  }

  async flush() {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const items = await this.store.claimDueGroupNotifications(20);
      for (const item of items) {
        try {
          if (item.kind === 'released-slot') {
            const state = await this.store.getState();
            const payload = item.payload || {};
            if (payload.week !== this.currentWeek() || !isCellVacant(state, payload.week, payload.personId, payload.date)) {
              await this.store.finishGroupNotification(item.id, { status: 'skipped', error: '排期已重新填入或已不属于本周' });
              continue;
            }
          }
          const message = item.kind === 'daily-vacancy'
            ? formatDailyVacancyMessage(item.payload || {}, this.appUrl)
            : formatReleasedSlotMessage(item.payload || {}, this.appUrl);
          await this.client.sendGroupMarkdown(this.conversationId, message.title, message.text);
          await this.store.finishGroupNotification(item.id, { status: 'sent' });
        } catch (error) {
          const attempts = Number(item.attempts || 0) + 1;
          const retryMs = [60_000, 5 * 60_000, 15 * 60_000][Math.min(attempts - 1, 2)];
          await this.store.finishGroupNotification(item.id, {
            status: attempts >= 3 ? 'failed' : 'pending',
            error: compactText(error && error.message, 500),
            retryAt: attempts >= 3 ? null : new Date(Date.now() + retryMs).toISOString(),
          });
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
  shanghaiParts,
  shanghaiDateKey,
  mondayKeyForDate,
  addDays,
  internalPeopleForWeek,
  scheduleEntriesForCell,
  isCellVacant,
  buildDailyVacancyPayload,
  formatDailyVacancyMessage,
  releaseCandidatesFromHistory,
  releaseNotificationFromCandidate,
  formatReleasedSlotMessage,
  GroupNotificationDispatcher,
};
