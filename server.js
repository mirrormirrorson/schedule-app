const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { Pool } = require('pg');
const {
  extractNotificationBatches,
  DingTalkClient,
  NotificationDispatcher,
} = require('./lib/dingtalk-notifier');
const {
  shanghaiParts,
  buildDailyVacancyPayload,
  releaseCandidatesFromHistory,
  releaseNotificationFromCandidate,
  isCellVacant,
  GroupNotificationDispatcher,
} = require('./lib/group-schedule-notifier');

const app = express();
const PORT = Number(process.env.PORT || 3456);
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'data', 'db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const MAX_HISTORY = 8000;
const MAX_PATCHES = 3000;
const USER_LAST_SEEN_WRITE_INTERVAL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.USER_LAST_SEEN_WRITE_INTERVAL_MS || 24 * 60 * 60 * 1000),
);
const PRESENCE_TTL_MS = 15_000;
const MAX_PRESENCE_SESSIONS = 200;
const PERMISSION_ADMIN_NAMES = new Set(['张雅镜', '林俊凯', '简慧仪']);
const DINGTALK_NOTIFY_ENABLED = /^(1|true|yes)$/i.test(process.env.DINGTALK_NOTIFY_ENABLED || '');
const DINGTALK_NOTIFY_AGGREGATE_MS = Math.min(
  5 * 60 * 1000,
  Math.max(30 * 1000, Number(process.env.DINGTALK_NOTIFY_AGGREGATE_MS || 60 * 1000)),
);
const DINGTALK_GROUP_NOTIFY_ENABLED = /^(1|true|yes)$/i.test(process.env.DINGTALK_GROUP_NOTIFY_ENABLED || '');
const DINGTALK_GROUP_OPEN_CONVERSATION_ID = String(process.env.DINGTALK_GROUP_OPEN_CONVERSATION_ID || '').trim();
const DINGTALK_GROUP_RELEASE_DELAY_MS = Math.min(
  10 * 60 * 1000,
  Math.max(30 * 1000, Number(process.env.DINGTALK_GROUP_RELEASE_DELAY_MS || 2 * 60 * 1000)),
);
const GROUP_NOTIFY_CRON_SECRET = String(process.env.GROUP_NOTIFY_CRON_SECRET || '').trim();
const EDITABLE_ROOTS = new Set([
  'internalPeople',
  'externalPeople',
  'groups',
  'conditionRules',
  'personRadarFields',
  'personRadarScores',
  'weekPeople',
  'weekPeopleLocked',
  'weekGroups',
  'weekGroupLocked',
  'groupColors',
  'schedules',
  'timeOff',
  'resolutions',
]);
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const presenceSessions = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

function nowIso() {
  return new Date().toISOString();
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function historyVersionOf(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of entries || []) {
    hash.update(String(entry && entry.id || ''));
    hash.update('\0');
    hash.update(String(entry && entry.opId || ''));
    hash.update('\0');
    hash.update(String(entry && entry.ts || ''));
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 20);
}

function isPermissionAdminName(name) {
  return PERMISSION_ADMIN_NAMES.has(String(name || '').trim());
}

const SCHEDULE_OPEN_HOUR_SHANGHAI = 14;

function shanghaiDateParts(now = new Date()) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]),
  );
}

function scheduleWeekKeyForShanghai(now = new Date()) {
  const parts = shanghaiDateParts(now);
  const localDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const day = localDate.getUTCDay();
  // 排班周始终指向下一周，不随周一开放时刻变化。
  const daysToNextMonday = day === 0 ? 1 : 8 - day;
  localDate.setUTCDate(localDate.getUTCDate() + daysToNextMonday);
  return `${localDate.getUTCFullYear()}-${String(localDate.getUTCMonth() + 1).padStart(2, '0')}-${String(localDate.getUTCDate()).padStart(2, '0')}`;
}

function currentWeekKeyForShanghai(now = new Date()) {
  const parts = shanghaiDateParts(now);
  const localDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const daysSinceMonday = (localDate.getUTCDay() + 6) % 7;
  localDate.setUTCDate(localDate.getUTCDate() - daysSinceMonday);
  return `${localDate.getUTCFullYear()}-${String(localDate.getUTCMonth() + 1).padStart(2, '0')}-${String(localDate.getUTCDate()).padStart(2, '0')}`;
}

function isScheduleWeekOpenForShanghai(now = new Date()) {
  const parts = shanghaiDateParts(now);
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay();
  return day !== 1 || Number(parts.hour) >= SCHEDULE_OPEN_HOUR_SHANGHAI;
}

function scheduleWriteBoundaryForShanghai(now = new Date()) {
  const scheduleWeek = new Date(`${scheduleWeekKeyForShanghai(now)}T00:00:00Z`);
  if (!isScheduleWeekOpenForShanghai(now)) scheduleWeek.setUTCDate(scheduleWeek.getUTCDate() - 7);
  return scheduleWeek.toISOString().slice(0, 10);
}

function futureScheduleWeeksFromChanges(changes, boundary = scheduleWriteBoundaryForShanghai()) {
  const weeks = new Set();
  for (const change of changes || []) {
    if (!change || !Array.isArray(change.path) || !['schedules', 'timeOff'].includes(change.path[0])) continue;
    const week = String(change.path[1] || '');
    if (week) {
      if (week > boundary) weeks.add(week);
      continue;
    }
    if (change.after && change.after.exists && change.after.value && typeof change.after.value === 'object') {
      Object.keys(change.after.value).forEach(key => { if (key > boundary) weeks.add(key); });
    }
  }
  return [...weeks].sort();
}

function normalizeAccountPermissions(source, name = '') {
  const isAdmin = isPermissionAdminName(name);
  return {
    canScoreRadar: isAdmin || source?.canScoreRadar === true || source?.can_score_radar === true,
    canManageRadarFields: isAdmin || source?.canManageRadarFields === true || source?.can_manage_radar_fields === true,
  };
}

function accountUserResponse(source) {
  if (!source) return null;
  const name = String(source.name || '').trim();
  const firstSeen = source.firstSeenAt || source.first_seen_at;
  const lastSeen = source.lastSeenAt || source.last_seen_at;
  return {
    id: source.id,
    name,
    firstSeenAt: firstSeen instanceof Date ? firstSeen.toISOString() : String(firstSeen || ''),
    lastSeenAt: lastSeen instanceof Date ? lastSeen.toISOString() : String(lastSeen || ''),
    isPermissionAdmin: isPermissionAdminName(name),
    permissions: normalizeAccountPermissions(source.permissions || source, name),
  };
}

function cleanPresenceText(value, maxLength = 100) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function normalizePresencePayload(source) {
  const body = source && typeof source === 'object' ? source : {};
  const sessionId = cleanPresenceText(body.sessionId, 80);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(sessionId)) throw new Error('invalid presence session');

  const active = body.active === true;
  const userName = cleanPresenceText(body.userName, 100);
  if (active && !userName) throw new Error('presence user required');

  const hasContext = !!body.context && typeof body.context === 'object';
  const context = hasContext ? body.context : {};
  const taskIndexValue = Number.parseInt(context.taskIndex, 10);
  return {
    sessionId,
    active,
    userName,
    context: hasContext ? {
      mode: context.mode === 'overview' ? 'overview' : 'group',
      status: context.status === 'dragging'
        ? 'dragging'
        : context.status === 'editing' ? 'editing' : 'selected',
      action: context.action === 'add' ? 'add' : 'edit',
      weekStart: cleanPresenceText(context.weekStart, 10),
      weekLabel: cleanPresenceText(context.weekLabel, 40),
      groupId: cleanPresenceText(context.groupId, 100),
      groupName: cleanPresenceText(context.groupName, 100),
      personId: cleanPresenceText(context.personId, 100),
      personName: cleanPresenceText(context.personName, 100),
      dateStr: cleanPresenceText(context.dateStr, 10),
      weekday: cleanPresenceText(context.weekday, 10),
      taskIndex: Number.isInteger(taskIndexValue) && taskIndexValue >= -1 && taskIndexValue <= 999
        ? taskIndexValue
        : -1,
    } : null,
  };
}

function prunePresence(now = Date.now()) {
  for (const [sessionId, session] of presenceSessions) {
    if (!session || now - session.lastSeen > PRESENCE_TTL_MS) presenceSessions.delete(sessionId);
  }
}

function getPresenceSnapshot(now = Date.now()) {
  prunePresence(now);
  return [...presenceSessions.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(session => ({
      sessionId: session.sessionId,
      userName: session.userName,
      context: cloneJson(session.context),
      updatedAt: session.lastSeen,
    }));
}

function defaultState() {
  return {
    internalPeople: [],
    externalPeople: [],
    groups: [],
    conditionRules: [],
    personRadarFields: [],
    personRadarScores: {},
    weekPeople: {},
    schedules: {},
    timeOff: {},
  };
}

function loadSeed() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : defaultState();
  } catch (error) {
    return defaultState();
  }
}

function editableState(source) {
  const result = {};
  for (const key of EDITABLE_ROOTS) {
    if (source && source[key] !== undefined) result[key] = cloneJson(source[key]);
  }
  return result;
}

function makeStateResponse(data, revision, updatedAt) {
  return {
    ...cloneJson(data),
    _revision: Number(revision || 0),
    _updated: new Date(updatedAt || Date.now()).getTime(),
  };
}

function validatePath(rawPath) {
  if (!Array.isArray(rawPath) || rawPath.length < 1 || rawPath.length > 20) {
    throw new Error('invalid patch path');
  }
  const result = rawPath.map(segment => {
    if (typeof segment !== 'string' || !segment || segment.length > 200 || FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      throw new Error('invalid patch path segment');
    }
    return segment;
  });
  if (!EDITABLE_ROOTS.has(result[0])) throw new Error('patch root is not editable');
  return result;
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.exists !== 'boolean') {
    throw new Error('invalid patch snapshot');
  }
  return snapshot.exists
    ? { exists: true, value: cloneJson(snapshot.value) }
    : { exists: false };
}

function readPath(root, segments) {
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const key = segments[index];
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) {
      return { exists: false };
    }
    current = current[key];
  }
  return { exists: true, value: cloneJson(current) };
}

function writePath(root, segments, snapshot) {
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index];
    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) {
      current[key] = {};
    }
    current = current[key];
  }
  const leaf = segments[segments.length - 1];
  if (snapshot.exists) current[leaf] = cloneJson(snapshot.value);
  else delete current[leaf];
}

function snapshotsEqual(left, right) {
  return left.exists === right.exists && (!left.exists || isDeepStrictEqual(left.value, right.value));
}

function normalizeChanges(rawChanges) {
  if (!Array.isArray(rawChanges) || rawChanges.length > MAX_PATCHES) {
    throw new Error('invalid patch list');
  }
  return rawChanges.map(change => ({
    path: validatePath(change && change.path),
    before: normalizeSnapshot(change && change.before),
    after: normalizeSnapshot(change && change.after),
  }));
}

function normalizeHistoryEntries(rawEntries) {
  if (!rawEntries) return [];
  if (!Array.isArray(rawEntries) || rawEntries.length > 1000) throw new Error('invalid history list');
  return rawEntries.filter(Boolean).map(entry => {
    const clean = cloneJson(entry);
    clean.id = typeof clean.id === 'string' && clean.id ? clean.id : `h_${crypto.randomUUID()}`;
    clean.ts = clean.ts && !Number.isNaN(Date.parse(clean.ts)) ? new Date(clean.ts).toISOString() : nowIso();
    for (const key of ['user', 'week', 'group', 'person', 'date', 'weekday', 'action', 'content', 'opId']) {
      if (clean[key] !== undefined && typeof clean[key] !== 'string') clean[key] = String(clean[key]);
      if (typeof clean[key] === 'string' && clean[key].length > 10000) clean[key] = clean[key].slice(0, 10000);
    }
    return clean;
  });
}

async function insertHistoryEntries(client, entries) {
  if (!entries.length) return;
  const rows = entries.map(entry => ({
    id: entry.id,
    op_id: entry.opId || null,
    ts: entry.ts,
    user_name: entry.user || null,
    week: entry.week || null,
    group_name: entry.group || null,
    person: entry.person || null,
    action: entry.action || null,
    content: entry.content || null,
    data: entry,
  }));
  await client.query(
    `INSERT INTO history_entries
       (id, op_id, ts, user_name, week, group_name, person, action, content, data)
     SELECT item.id, item.op_id, item.ts::timestamptz, item.user_name, item.week,
            item.group_name, item.person, item.action, item.content, item.data
     FROM jsonb_to_recordset($1::jsonb) AS item(
       id text, op_id text, ts text, user_name text, week text,
       group_name text, person text, action text, content text, data jsonb
     )
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(rows)],
  );
}

function applyChanges(currentData, changes) {
  const nextData = cloneJson(currentData);
  const conflicts = [];
  for (const change of changes) {
    const current = readPath(nextData, change.path);
    if (snapshotsEqual(current, change.after)) continue;
    if (!snapshotsEqual(current, change.before)) {
      conflicts.push({
        path: change.path,
        server: current,
        yours: change.after,
      });
      continue;
    }
    writePath(nextData, change.path, change.after);
  }
  return { nextData, conflicts };
}

class FileStore {
  constructor(seed) {
    this.document = editableState(seed);
    this.users = cloneJson(seed.users || {});
    this.history = cloneJson(seed.history || []);
    this.revision = Number(seed._revision || 1);
    this.updatedAt = new Date(seed._updated || Date.now()).toISOString();
    this.mutations = new Map();
    this.dingtalkBindings = new Map();
    this.notificationOutbox = new Map();
    this.groupNotificationOutbox = new Map();
    this.historyVersion = historyVersionOf(this.history);
    this.queue = Promise.resolve();
  }

  async init() {
    await this.persist();
  }

  withLock(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async persist() {
    const payload = {
      ...this.document,
      users: this.users,
      history: this.history,
      _revision: this.revision,
      _updated: new Date(this.updatedAt).getTime(),
    };
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(`${DB_PATH}.tmp`, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(`${DB_PATH}.tmp`, DB_PATH);
  }

  async getState() {
    return makeStateResponse(this.document, this.revision, this.updatedAt);
  }

  async getMeta() {
    return { _revision: this.revision, _updated: this.updatedAt };
  }

  async applyPatch({ mutationId, changes, historyEntries, notificationBatches = [], releaseCandidates = [] }) {
    return this.withLock(async () => {
      if (this.mutations.has(mutationId)) {
        return { duplicate: true, state: await this.getState(), conflicts: [], groupNotificationWake: false };
      }
      const result = applyChanges(this.document, changes);
      if (result.conflicts.length) {
        return { duplicate: false, state: await this.getState(), conflicts: result.conflicts, groupNotificationWake: false };
      }
      this.document = result.nextData;
      this.history.push(...historyEntries);
      if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
      if (historyEntries.length) this.historyVersion = historyVersionOf(this.history);
      this.revision += 1;
      this.updatedAt = nowIso();
      this.mutations.set(mutationId, this.revision);
      await this.enqueueNotificationBatches(notificationBatches);
      const groupNotificationWake = await this.reconcileReleaseWatches(releaseCandidates, this.document, mutationId);
      if (this.mutations.size > 5000) this.mutations.delete(this.mutations.keys().next().value);
      await this.persist();
      return { duplicate: false, state: await this.getState(), conflicts: [], groupNotificationWake };
    });
  }

  async replaceState(next, expectedRevision) {
    return this.withLock(async () => {
      if (Number(expectedRevision) !== this.revision) {
        return { conflict: true, state: await this.getState() };
      }
      this.document = editableState(next);
      this.revision += 1;
      this.updatedAt = nowIso();
      await this.persist();
      return { conflict: false, state: await this.getState() };
    });
  }

  async identify(name) {
    return this.withLock(async () => {
      const timestamp = nowIso();
      let user = this.users[name];
      if (!user) {
        user = {
          id: `u_${crypto.randomUUID()}`,
          name,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          permissions: normalizeAccountPermissions({}, name),
        };
        this.users[name] = user;
      } else {
        user.lastSeenAt = timestamp;
        user.permissions = normalizeAccountPermissions(user.permissions || user, name);
        delete user.lastIp;
      }
      await this.persist();
      return accountUserResponse(user);
    });
  }

  async getUserById(id) {
    const user = Object.values(this.users).find(item => item && item.id === id);
    return accountUserResponse(user);
  }

  async listUsers() {
    return Object.values(this.users)
      .map(accountUserResponse)
      .filter(Boolean)
      .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
  }

  async updateUserPermissions(id, permissions) {
    return this.withLock(async () => {
      const user = Object.values(this.users).find(item => item && item.id === id);
      if (!user) return null;
      user.permissions = normalizeAccountPermissions(permissions, user.name);
      await this.persist();
      return accountUserResponse(user);
    });
  }

  async deleteUser(id) {
    return this.withLock(async () => {
      const entry = Object.entries(this.users).find(([, item]) => item && item.id === id);
      if (!entry) return null;
      const [name, user] = entry;
      if (isPermissionAdminName(name)) return { protected: true, user: accountUserResponse(user) };
      delete this.users[name];
      await this.persist();
      return { protected: false, user: accountUserResponse(user) };
    });
  }

  async listHistory({ group, user, query, limit }) {
    let rows = this.history.slice();
    if (group) rows = rows.filter(item => item.group === group || (group === '总览' && (!item.group || item.group === '总览')));
    if (user) rows = rows.filter(item => item.user === user);
    if (query) {
      const needle = query.toLowerCase();
      rows = rows.filter(item => [item.content, item.user, item.person, item.group].some(value => String(value || '').toLowerCase().includes(needle)));
    }
    rows.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    return cloneJson(rows.slice(0, limit));
  }

  async appendHistory(entries) {
    return this.withLock(async () => {
      const seen = new Set(this.history.map(entry => entry.id));
      this.history.push(...entries.filter(entry => !seen.has(entry.id)));
      if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
      if (entries.length) this.historyVersion = historyVersionOf(this.history);
      await this.persist();
      return entries.length;
    });
  }

  async removeHistory(opIds) {
    return this.withLock(async () => {
      const wanted = new Set(opIds);
      const removed = this.history.filter(item => item.opId && wanted.has(item.opId));
      this.history = this.history.filter(item => !(item.opId && wanted.has(item.opId)));
      if (removed.length) this.historyVersion = historyVersionOf(this.history);
      await this.persist();
      return cloneJson(removed);
    });
  }

  getHistoryVersion() {
    return this.historyVersion;
  }

  async listDingTalkBindings() {
    return [...this.dingtalkBindings.values()].map(cloneJson);
  }

  async getDingTalkBinding(personId) {
    return cloneJson(this.dingtalkBindings.get(personId) || null);
  }

  async upsertDingTalkBinding(binding) {
    const saved = { ...cloneJson(binding), updatedAt: nowIso() };
    this.dingtalkBindings.set(saved.personId, saved);
    return cloneJson(saved);
  }

  async deleteDingTalkBinding(personId) {
    return this.dingtalkBindings.delete(personId);
  }

  async enqueueNotificationBatches(batches) {
    const availableAt = new Date(Date.now() + DINGTALK_NOTIFY_AGGREGATE_MS).toISOString();
    for (const batch of batches || []) {
      if (!this.notificationOutbox.has(batch.id)) {
        this.notificationOutbox.set(batch.id, {
          ...cloneJson(batch), status: 'pending', availableAt, attempts: 0,
          lastError: '', createdAt: nowIso(), sentAt: null,
        });
      }
      for (const item of this.notificationOutbox.values()) {
        if (item.personId === batch.personId && item.status === 'pending') item.availableAt = availableAt;
      }
    }
  }

  async requeueStaleNotifications() {
    const now = Date.now();
    for (const item of this.notificationOutbox.values()) {
      if (item.status === 'processing' && new Date(item.availableAt).getTime() <= now) item.status = 'pending';
    }
  }

  async nextNotificationAt() {
    const pending = [...this.notificationOutbox.values()].filter(item => item.status === 'pending');
    if (!pending.length) return null;
    return pending.sort((a, b) => new Date(a.availableAt) - new Date(b.availableAt))[0].availableAt;
  }

  async claimDueNotifications(limit) {
    const now = Date.now();
    const retentionCutoff = now - 90 * 24 * 60 * 60 * 1000;
    for (const [id, item] of this.notificationOutbox) {
      if (item.status !== 'pending' && item.status !== 'processing' && new Date(item.createdAt).getTime() < retentionCutoff) {
        this.notificationOutbox.delete(id);
      }
    }
    const rows = [...this.notificationOutbox.values()]
      .filter(item => item.status === 'pending' && new Date(item.availableAt).getTime() <= now)
      .sort((a, b) => new Date(a.availableAt) - new Date(b.availableAt))
      .slice(0, limit);
    rows.forEach(item => {
      item.status = 'processing';
      item.availableAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    });
    return rows.map(cloneJson);
  }

  async finishNotification(id, result) {
    const item = this.notificationOutbox.get(id);
    if (!item) return;
    item.status = result.status;
    item.lastError = result.error || '';
    if (result.error) item.attempts += 1;
    if (result.retryAt) item.availableAt = result.retryAt;
    if (result.status === 'sent') item.sentAt = nowIso();
  }

  async listNotificationLogs(limit = 50) {
    return [...this.notificationOutbox.values()]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit)
      .map(cloneJson);
  }

  async reconcileReleaseWatches(candidates, state, mutationId) {
    let enqueued = false;
    const byCell = new Map();
    for (const candidate of candidates || []) {
      const key = `${candidate.week}\0${candidate.personId}\0${candidate.date}`;
      if (!byCell.has(key)) byCell.set(key, []);
      byCell.get(key).push(candidate);
    }
    for (const group of byCell.values()) {
      const candidate = group.find(item => item.trigger === 'release') || group[0];
      for (const item of this.groupNotificationOutbox.values()) {
        const payload = item.payload || {};
        if (item.kind === 'released-slot' && item.status === 'pending'
          && payload.week === candidate.week && payload.personId === candidate.personId && payload.date === candidate.date) {
          item.status = 'cancelled';
          item.lastError = '排期发生后续变更';
        }
      }
      if (!group.some(item => item.trigger === 'release')
        || !isCellVacant(state, candidate.week, candidate.personId, candidate.date)) continue;
      const notification = releaseNotificationFromCandidate(candidate, mutationId);
      if (this.groupNotificationOutbox.has(notification.id)) continue;
      this.groupNotificationOutbox.set(notification.id, {
        ...notification, status: 'pending', attempts: 0, lastError: '', createdAt: nowIso(), sentAt: null,
        availableAt: new Date(Date.now() + DINGTALK_GROUP_RELEASE_DELAY_MS).toISOString(),
      });
      enqueued = true;
    }
    return enqueued;
  }

  async enqueueDailyGroupNotification(payload) {
    const id = `gn_daily_${payload.runDate}`;
    if (this.groupNotificationOutbox.has(id)) return { inserted: false, empty: !(payload.items || []).length };
    const empty = !(payload.items || []).length;
    this.groupNotificationOutbox.set(id, {
      id, dedupeKey: `daily:${payload.runDate}`, kind: 'daily-vacancy', payload: cloneJson(payload),
      status: empty ? 'skipped' : 'pending', attempts: 0, lastError: empty ? '没有空余排期' : '',
      createdAt: nowIso(), sentAt: null, availableAt: nowIso(),
    });
    return { inserted: true, empty };
  }

  async requeueStaleGroupNotifications() {
    for (const item of this.groupNotificationOutbox.values()) {
      // 服务启动时已不存在上一个活跃 worker，因此所有 processing 均应回队。
      // 否则在 10 分钟可见性超时内重启，这条消息会永久卡住。
      if (item.status === 'processing') item.status = 'pending';
    }
  }

  async nextGroupNotificationAt() {
    const pending = [...this.groupNotificationOutbox.values()].filter(item => item.status === 'pending');
    if (!pending.length) return null;
    return pending.sort((a, b) => new Date(a.availableAt) - new Date(b.availableAt))[0].availableAt;
  }

  async claimDueGroupNotifications(limit) {
    const now = Date.now();
    const rows = [...this.groupNotificationOutbox.values()]
      .filter(item => item.status === 'pending' && new Date(item.availableAt).getTime() <= now)
      .sort((a, b) => new Date(a.availableAt) - new Date(b.availableAt))
      .slice(0, limit);
    rows.forEach(item => {
      item.status = 'processing';
      item.availableAt = new Date(now + 10 * 60 * 1000).toISOString();
    });
    return rows.map(cloneJson);
  }

  async finishGroupNotification(id, result) {
    const item = this.groupNotificationOutbox.get(id);
    if (!item) return;
    item.status = result.status;
    item.lastError = result.error || '';
    if (result.error && result.status !== 'skipped') item.attempts += 1;
    if (result.retryAt) item.availableAt = result.retryAt;
    if (result.status === 'sent') item.sentAt = nowIso();
  }

  async close() {}
}

class PostgresStore {
  constructor(connectionString, seed, options = {}) {
    this.seed = seed;
    this.meta = null;
    this.stateCache = null;
    this.usersById = new Map();
    this.usersByName = new Map();
    this.persistedLastSeenByName = new Map();
    this.historyCache = [];
    this.historyVersion = historyVersionOf([]);
    this.writeQueue = Promise.resolve();
    this.lastMutationCleanupAt = 0;
    this.pool = options.pool || new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
  }

  async init() {
    const schema = fs.readFileSync(path.join(__dirname, 'migrations', '001_init.sql'), 'utf8');
    await this.pool.query(schema);
    const seedData = editableState(this.seed);
    await this.pool.query(
      `INSERT INTO app_state (id, data, revision, updated_at)
       VALUES (1, $1::jsonb, 1, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(seedData)],
    );
    await this.refreshCachesFromDb();
  }

  setStateCache(state) {
    this.stateCache = cloneJson(state);
    this.meta = { _revision: state._revision, _updated: state._updated };
  }

  setUsersCache(rows) {
    this.usersById.clear();
    this.usersByName.clear();
    this.persistedLastSeenByName.clear();
    for (const row of rows || []) this.cacheUser(row, true);
  }

  cacheUser(source, markPersisted = false) {
    const user = accountUserResponse(source);
    if (!user) return null;
    const cached = cloneJson(user);
    this.usersById.set(cached.id, cached);
    this.usersByName.set(cached.name, cached);
    if (markPersisted) {
      this.persistedLastSeenByName.set(cached.name, Date.parse(cached.lastSeenAt) || Date.now());
    }
    return cloneJson(cached);
  }

  setHistoryCache(entries) {
    this.historyCache = cloneJson(entries || [])
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, MAX_HISTORY);
    this.historyVersion = historyVersionOf(this.historyCache);
  }

  mergeHistoryCache(entries) {
    if (!entries || !entries.length) return;
    const byId = new Map(this.historyCache.map(entry => [entry.id, entry]));
    for (const entry of entries) {
      if (!byId.has(entry.id)) byId.set(entry.id, cloneJson(entry));
    }
    this.historyCache = [...byId.values()]
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, MAX_HISTORY);
    this.historyVersion = historyVersionOf(this.historyCache);
  }

  async readStateFromDb(client = this.pool) {
    const result = await client.query('SELECT data, revision, updated_at FROM app_state WHERE id = 1');
    const row = result.rows[0];
    return makeStateResponse(row.data, row.revision, row.updated_at);
  }

  async refreshCachesFromDb(client = this.pool) {
    const [state, users, history] = await Promise.all([
      this.readStateFromDb(client),
      client.query(
        `SELECT id, name, first_seen_at, last_seen_at, can_score_radar, can_manage_radar_fields
         FROM app_users ORDER BY last_seen_at DESC, name ASC`,
      ),
      client.query(
        `SELECT data FROM history_entries
         ORDER BY ts DESC, id DESC LIMIT $1`,
        [MAX_HISTORY],
      ),
    ]);
    this.setStateCache(state);
    this.setUsersCache(users.rows);
    this.setHistoryCache(history.rows.map(row => row.data));
  }

  withWriteLock(fn) {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async getState() {
    if (!this.stateCache) this.setStateCache(await this.readStateFromDb());
    return cloneJson(this.stateCache);
  }

  async getMeta() {
    if (!this.meta) {
      const state = await this.readStateFromDb();
      this.setStateCache(state);
      return { _revision: state._revision, _updated: state._updated };
    }
    return { ...this.meta };
  }

  async applyPatch({ mutationId, changes, historyEntries, notificationBatches = [], releaseCandidates = [] }) {
    return this.withWriteLock(() => this.applyPatchLocked({
      mutationId, changes, historyEntries, notificationBatches, releaseCandidates,
    }));
  }

  async applyPatchLocked({ mutationId, changes, historyEntries, notificationBatches, releaseCandidates }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT revision, updated_at FROM app_state WHERE id = 1 FOR UPDATE');
      const row = locked.rows[0];
      let currentState = this.stateCache;
      if (!currentState || Number(currentState._revision) !== Number(row.revision)) {
        currentState = await this.readStateFromDb(client);
        this.setStateCache(currentState);
      }
      const existingAfterLock = await client.query('SELECT revision FROM mutations WHERE id = $1', [mutationId]);
      if (existingAfterLock.rowCount) {
        await client.query('COMMIT');
        return { duplicate: true, state: cloneJson(currentState), conflicts: [], groupNotificationWake: false };
      }
      const result = applyChanges(editableState(currentState), changes);
      if (result.conflicts.length) {
        await client.query('ROLLBACK');
        return { duplicate: false, state: cloneJson(currentState), conflicts: result.conflicts, groupNotificationWake: false };
      }

      const updated = await client.query(
        `UPDATE app_state
         SET data = $1::jsonb, revision = revision + 1, updated_at = NOW()
         WHERE id = 1
         RETURNING revision, updated_at`,
        [JSON.stringify(result.nextData)],
      );
      const revision = Number(updated.rows[0].revision);

      await insertHistoryEntries(client, historyEntries);
      await this.enqueueNotificationBatches(notificationBatches, client);
      const groupNotificationWake = await this.reconcileReleaseWatches(
        releaseCandidates, result.nextData, mutationId, client,
      );
      if (historyEntries.length) {
        await client.query(
          `DELETE FROM history_entries
           WHERE id IN (
             SELECT id FROM history_entries
             ORDER BY ts DESC, id DESC
             OFFSET $1
           )`,
          [MAX_HISTORY],
        );
      }
      await client.query('INSERT INTO mutations (id, revision) VALUES ($1, $2)', [mutationId, revision]);
      const shouldCleanupMutations = Date.now() - this.lastMutationCleanupAt >= 24 * 60 * 60 * 1000;
      if (shouldCleanupMutations) {
        await client.query(`DELETE FROM mutations WHERE created_at < NOW() - INTERVAL '30 days'`);
      }
      await client.query('COMMIT');
      if (shouldCleanupMutations) this.lastMutationCleanupAt = Date.now();

      const state = makeStateResponse(result.nextData, revision, updated.rows[0].updated_at);
      this.setStateCache(state);
      this.mergeHistoryCache(historyEntries);
      return {
        duplicate: false,
        state,
        conflicts: [],
        groupNotificationWake,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceState(next, expectedRevision) {
    return this.withWriteLock(() => this.replaceStateLocked(next, expectedRevision));
  }

  async replaceStateLocked(next, expectedRevision) {
    const updated = await this.pool.query(
      `UPDATE app_state
       SET data = $1::jsonb, revision = revision + 1, updated_at = NOW()
       WHERE id = 1 AND revision = $2
       RETURNING revision, updated_at`,
      [JSON.stringify(editableState(next)), Number(expectedRevision)],
    );
    if (!updated.rowCount) {
      const state = await this.readStateFromDb();
      this.setStateCache(state);
      return { conflict: true, state };
    }
    const row = updated.rows[0];
    const state = makeStateResponse(editableState(next), row.revision, row.updated_at);
    this.setStateCache(state);
    return { conflict: false, state };
  }

  async identify(name) {
    const cached = this.usersByName.get(name);
    const timestamp = Date.now();
    if (cached) {
      cached.lastSeenAt = new Date(timestamp).toISOString();
      this.usersById.set(cached.id, cached);
      const persistedAt = this.persistedLastSeenByName.get(name) || 0;
      if (timestamp - persistedAt < USER_LAST_SEEN_WRITE_INTERVAL_MS) return cloneJson(cached);
    }
    const admin = isPermissionAdminName(name);
    const result = await this.pool.query(
      `INSERT INTO app_users
         (name, id, first_seen_at, last_seen_at, can_score_radar, can_manage_radar_fields)
       VALUES ($1, $2, NOW(), NOW(), $3, $3)
       ON CONFLICT (name)
       DO UPDATE SET
         last_seen_at = NOW(),
         can_score_radar = app_users.can_score_radar OR EXCLUDED.can_score_radar,
         can_manage_radar_fields = app_users.can_manage_radar_fields OR EXCLUDED.can_manage_radar_fields
       RETURNING id, name, first_seen_at, last_seen_at, can_score_radar, can_manage_radar_fields`,
      [name, `u_${crypto.randomUUID()}`, admin],
    );
    return this.cacheUser(result.rows[0], true);
  }

  async getUserById(id) {
    return cloneJson(this.usersById.get(id) || null);
  }

  async listUsers() {
    return [...this.usersById.values()]
      .map(cloneJson)
      .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt) || a.name.localeCompare(b.name, 'zh-CN'));
  }

  async updateUserPermissions(id, permissions) {
    const user = await this.getUserById(id);
    if (!user) return null;
    const normalized = normalizeAccountPermissions(permissions, user.name);
    const result = await this.pool.query(
      `UPDATE app_users
       SET can_score_radar = $2, can_manage_radar_fields = $3
       WHERE id = $1
       RETURNING id, name, first_seen_at, last_seen_at, can_score_radar, can_manage_radar_fields`,
      [id, normalized.canScoreRadar, normalized.canManageRadarFields],
    );
    return this.cacheUser(result.rows[0], true);
  }

  async deleteUser(id) {
    const user = await this.getUserById(id);
    if (!user) return null;
    if (isPermissionAdminName(user.name)) return { protected: true, user };
    await this.pool.query('DELETE FROM app_users WHERE id = $1', [id]);
    this.usersById.delete(id);
    this.usersByName.delete(user.name);
    this.persistedLastSeenByName.delete(user.name);
    return { protected: false, user };
  }

  async listHistory({ group, user, query, limit }) {
    let rows = this.historyCache.slice();
    if (group) rows = rows.filter(item => item.group === group || (group === '总览' && (!item.group || item.group === '总览')));
    if (user) rows = rows.filter(item => item.user === user);
    if (query) {
      const needle = query.toLowerCase();
      rows = rows.filter(item => [item.content, item.user, item.person, item.group]
        .some(value => String(value || '').toLowerCase().includes(needle)));
    }
    return cloneJson(rows.slice(0, limit));
  }

  async appendHistory(entries) {
    return this.withWriteLock(() => this.appendHistoryLocked(entries));
  }

  async appendHistoryLocked(entries) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await insertHistoryEntries(client, entries);
      if (entries.length) {
        await client.query(
          `DELETE FROM history_entries
           WHERE id IN (
             SELECT id FROM history_entries
             ORDER BY ts DESC, id DESC
             OFFSET $1
           )`,
          [MAX_HISTORY],
        );
      }
      await client.query('COMMIT');
      this.mergeHistoryCache(entries);
      return entries.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async removeHistory(opIds) {
    return this.withWriteLock(() => this.removeHistoryLocked(opIds));
  }

  async removeHistoryLocked(opIds) {
    if (!opIds.length) return [];
    const result = await this.pool.query(
      'DELETE FROM history_entries WHERE op_id = ANY($1::text[]) RETURNING data',
      [opIds],
    );
    const removed = result.rows.map(row => row.data);
    if (removed.length) {
      const removedIds = new Set(removed.map(entry => entry.id));
      this.historyCache = this.historyCache.filter(entry => !removedIds.has(entry.id));
      this.historyVersion = historyVersionOf(this.historyCache);
    }
    return removed;
  }

  async importSnapshot(snapshot) {
    return this.withWriteLock(() => this.importSnapshotLocked(snapshot));
  }

  async importSnapshotLocked(snapshot) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM app_state WHERE id = 1 FOR UPDATE');
      await client.query(
        `UPDATE app_state
         SET data = $1::jsonb, revision = revision + 1, updated_at = NOW()
         WHERE id = 1`,
        [JSON.stringify(editableState(snapshot))],
      );
      await client.query('DELETE FROM history_entries');
      await client.query('DELETE FROM app_users');
      await insertHistoryEntries(client, normalizeHistoryEntries(snapshot.history || []));
      for (const [name, rawUser] of Object.entries(snapshot.users || {})) {
        const firstSeen = rawUser.firstSeenAt && !Number.isNaN(Date.parse(rawUser.firstSeenAt)) ? rawUser.firstSeenAt : nowIso();
        const lastSeen = rawUser.lastSeenAt && !Number.isNaN(Date.parse(rawUser.lastSeenAt)) ? rawUser.lastSeenAt : firstSeen;
        const permissions = normalizeAccountPermissions(rawUser.permissions || rawUser, name);
        await client.query(
          `INSERT INTO app_users
             (name, id, first_seen_at, last_seen_at, can_score_radar, can_manage_radar_fields)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (name) DO UPDATE
           SET last_seen_at = EXCLUDED.last_seen_at,
               can_score_radar = EXCLUDED.can_score_radar,
               can_manage_radar_fields = EXCLUDED.can_manage_radar_fields`,
          [name, rawUser.id || `u_${crypto.randomUUID()}`, firstSeen, lastSeen,
            permissions.canScoreRadar, permissions.canManageRadarFields],
        );
      }
      await client.query('COMMIT');
      await this.refreshCachesFromDb(client);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  async listDingTalkBindings() {
    const result = await this.pool.query(
      `SELECT person_id, person_name, dingtalk_user_id, enabled, updated_by, updated_at
       FROM dingtalk_bindings ORDER BY person_name ASC`,
    );
    return result.rows.map(row => ({
      personId: row.person_id,
      personName: row.person_name,
      dingtalkUserId: row.dingtalk_user_id,
      enabled: row.enabled,
      updatedBy: row.updated_by,
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async getDingTalkBinding(personId) {
    const result = await this.pool.query(
      `SELECT person_id, person_name, dingtalk_user_id, enabled, updated_by, updated_at
       FROM dingtalk_bindings WHERE person_id = $1`,
      [personId],
    );
    const row = result.rows[0];
    return row ? {
      personId: row.person_id,
      personName: row.person_name,
      dingtalkUserId: row.dingtalk_user_id,
      enabled: row.enabled,
      updatedBy: row.updated_by,
      updatedAt: new Date(row.updated_at).toISOString(),
    } : null;
  }

  async upsertDingTalkBinding(binding) {
    const result = await this.pool.query(
      `INSERT INTO dingtalk_bindings
         (person_id, person_name, dingtalk_user_id, enabled, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (person_id) DO UPDATE SET
         person_name = EXCLUDED.person_name,
         dingtalk_user_id = EXCLUDED.dingtalk_user_id,
         enabled = EXCLUDED.enabled,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING person_id, person_name, dingtalk_user_id, enabled, updated_by, updated_at`,
      [binding.personId, binding.personName, binding.dingtalkUserId, binding.enabled, binding.updatedBy],
    );
    const row = result.rows[0];
    return {
      personId: row.person_id, personName: row.person_name, dingtalkUserId: row.dingtalk_user_id,
      enabled: row.enabled, updatedBy: row.updated_by, updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async deleteDingTalkBinding(personId) {
    const result = await this.pool.query('DELETE FROM dingtalk_bindings WHERE person_id = $1', [personId]);
    return result.rowCount > 0;
  }

  async enqueueNotificationBatches(batches, client = this.pool) {
    if (!batches || !batches.length) return;
    const rows = batches.map(batch => ({ ...batch, availableAt: new Date(Date.now() + DINGTALK_NOTIFY_AGGREGATE_MS).toISOString() }));
    await client.query(
      `WITH incoming AS (
         SELECT item.id, item.mutation_id, item.person_id, item.person_name,
                item.actor_name, item.payload, item.available_at::timestamptz AS available_at
         FROM jsonb_to_recordset($1::jsonb) AS item(
           id text, mutation_id text, person_id text, person_name text,
           actor_name text, payload jsonb, available_at text
         )
       ), inserted AS (
         INSERT INTO notification_outbox
           (id, mutation_id, person_id, person_name, actor_name, payload, available_at)
         SELECT id, mutation_id, person_id, person_name, actor_name, payload, available_at
         FROM incoming
         ON CONFLICT (mutation_id, person_id) DO NOTHING
         RETURNING person_id
       )
       UPDATE notification_outbox AS queued
       SET available_at = GREATEST(queued.available_at, incoming.available_at)
       FROM incoming
       WHERE queued.person_id = incoming.person_id AND queued.status = 'pending'`,
      [JSON.stringify(rows.map(row => ({
        id: row.id, mutation_id: row.mutationId, person_id: row.personId,
        person_name: row.personName, actor_name: row.actorName,
        payload: { events: row.events }, available_at: row.availableAt,
      })))],
    );
  }

  async requeueStaleNotifications() {
    await this.pool.query(
      `UPDATE notification_outbox SET status = 'pending'
       WHERE status = 'processing' AND available_at <= NOW()`,
    );
  }

  async nextNotificationAt() {
    const result = await this.pool.query(
      `SELECT MIN(available_at) AS next_at FROM notification_outbox WHERE status = 'pending'`,
    );
    return result.rows[0] && result.rows[0].next_at;
  }

  async claimDueNotifications(limit) {
    const result = await this.pool.query(
      `WITH cleanup AS (
         DELETE FROM notification_outbox
         WHERE status IN ('sent', 'skipped', 'failed')
           AND created_at < NOW() - INTERVAL '90 days'
         RETURNING id
       ), due AS (
         SELECT id FROM notification_outbox
         WHERE status = 'pending' AND available_at <= NOW()
         ORDER BY available_at ASC LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE notification_outbox AS item
       SET status = 'processing', available_at = NOW() + INTERVAL '10 minutes'
       FROM due WHERE item.id = due.id
       RETURNING item.id, item.mutation_id, item.person_id, item.person_name,
                 item.actor_name, item.payload, item.attempts, item.created_at`,
      [limit],
    );
    return result.rows.map(row => ({
      id: row.id, mutationId: row.mutation_id, personId: row.person_id,
      personName: row.person_name, actorName: row.actor_name,
      events: (row.payload && row.payload.events) || [], attempts: row.attempts,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async finishNotification(id, result) {
    await this.pool.query(
      `UPDATE notification_outbox
       SET status = $2,
           attempts = attempts + CASE WHEN $3::text IS NULL THEN 0 ELSE 1 END,
           last_error = $3,
           available_at = COALESCE($4::timestamptz, available_at),
           sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
       WHERE id = $1`,
      [id, result.status, result.error || null, result.retryAt || null],
    );
  }

  async listNotificationLogs(limit = 50) {
    const result = await this.pool.query(
      `SELECT id, person_id, person_name, actor_name, status, attempts,
              last_error, created_at, sent_at
       FROM notification_outbox ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(row => ({
      id: row.id, personId: row.person_id, personName: row.person_name,
      actorName: row.actor_name, status: row.status, attempts: row.attempts,
      lastError: row.last_error || '', createdAt: new Date(row.created_at).toISOString(),
      sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    }));
  }

  async reconcileReleaseWatches(candidates, state, mutationId, client = this.pool) {
    let enqueued = false;
    const byCell = new Map();
    for (const candidate of candidates || []) {
      const key = `${candidate.week}\0${candidate.personId}\0${candidate.date}`;
      if (!byCell.has(key)) byCell.set(key, []);
      byCell.get(key).push(candidate);
    }
    for (const group of byCell.values()) {
      const candidate = group.find(item => item.trigger === 'release') || group[0];
      await client.query(
        `UPDATE group_notification_outbox
         SET status = 'cancelled', last_error = '排期发生后续变更'
         WHERE kind = 'released-slot' AND status = 'pending'
           AND payload->>'week' = $1 AND payload->>'personId' = $2 AND payload->>'date' = $3`,
        [candidate.week, candidate.personId, candidate.date],
      );
      if (!group.some(item => item.trigger === 'release')
        || !isCellVacant(state, candidate.week, candidate.personId, candidate.date)) continue;
      const notification = releaseNotificationFromCandidate(candidate, mutationId);
      const result = await client.query(
        `INSERT INTO group_notification_outbox
           (id, dedupe_key, kind, payload, status, available_at)
         VALUES ($1, $2, $3, $4::jsonb, 'pending', NOW() + ($5::bigint * INTERVAL '1 millisecond'))
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`,
        [notification.id, notification.dedupeKey, notification.kind, JSON.stringify(notification.payload), DINGTALK_GROUP_RELEASE_DELAY_MS],
      );
      if (result.rowCount) enqueued = true;
    }
    return enqueued;
  }

  async enqueueDailyGroupNotification(payload) {
    const empty = !(payload.items || []).length;
    const result = await this.pool.query(
      `INSERT INTO group_notification_outbox
         (id, dedupe_key, kind, payload, status, available_at, last_error)
       VALUES ($1, $2, 'daily-vacancy', $3::jsonb, $4, NOW(), $5)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        `gn_daily_${payload.runDate}`,
        `daily:${payload.runDate}`,
        JSON.stringify(payload),
        empty ? 'skipped' : 'pending',
        empty ? '没有空余排期' : null,
      ],
    );
    return { inserted: result.rowCount > 0, empty };
  }

  async requeueStaleGroupNotifications() {
    await this.pool.query(
      `UPDATE group_notification_outbox SET status = 'pending'
       WHERE status = 'processing'`,
    );
  }

  async nextGroupNotificationAt() {
    const result = await this.pool.query(
      `SELECT MIN(available_at) AS next_at FROM group_notification_outbox WHERE status = 'pending'`,
    );
    return result.rows[0] && result.rows[0].next_at;
  }

  async claimDueGroupNotifications(limit) {
    const result = await this.pool.query(
      `WITH cleanup AS (
         DELETE FROM group_notification_outbox
         WHERE status IN ('sent', 'skipped', 'failed', 'cancelled')
           AND created_at < NOW() - INTERVAL '90 days'
         RETURNING id
       ), due AS (
         SELECT id FROM group_notification_outbox
         WHERE status = 'pending' AND available_at <= NOW()
         ORDER BY available_at ASC LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE group_notification_outbox AS item
       SET status = 'processing', available_at = NOW() + INTERVAL '10 minutes'
       FROM due WHERE item.id = due.id
       RETURNING item.id, item.kind, item.payload, item.attempts, item.created_at`,
      [limit],
    );
    return result.rows.map(row => ({
      id: row.id, kind: row.kind, payload: row.payload, attempts: row.attempts,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async finishGroupNotification(id, result) {
    await this.pool.query(
      `UPDATE group_notification_outbox
       SET status = $2,
           attempts = attempts + CASE WHEN $3::text IS NULL OR $2 = 'skipped' THEN 0 ELSE 1 END,
           last_error = $3,
           available_at = COALESCE($4::timestamptz, available_at),
           sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
       WHERE id = $1`,
      [id, result.status, result.error || null, result.retryAt || null],
    );
  }

  getHistoryVersion() {
    return this.historyVersion;
  }
}

const seed = loadSeed();
const store = DATABASE_URL ? new PostgresStore(DATABASE_URL, seed) : new FileStore(seed);
const dingtalkClient = new DingTalkClient({
  clientId: process.env.DINGTALK_CLIENT_ID,
  clientSecret: process.env.DINGTALK_CLIENT_SECRET,
  robotCode: process.env.DINGTALK_ROBOT_CODE,
});
const notificationDispatcher = new NotificationDispatcher({
  store,
  client: dingtalkClient,
  enabled: DINGTALK_NOTIFY_ENABLED,
  appUrl: process.env.PUBLIC_APP_URL,
});
const groupNotificationDispatcher = new GroupNotificationDispatcher({
  store,
  client: dingtalkClient,
  enabled: DINGTALK_GROUP_NOTIFY_ENABLED,
  conversationId: DINGTALK_GROUP_OPEN_CONVERSATION_ID,
  appUrl: process.env.PUBLIC_APP_URL,
  currentWeek: currentWeekKeyForShanghai,
});

function validCronSecret(value) {
  const incoming = Buffer.from(String(value || ''));
  const expected = Buffer.from(GROUP_NOTIFY_CRON_SECRET);
  return expected.length > 0 && incoming.length === expected.length && crypto.timingSafeEqual(incoming, expected);
}

async function authorizedAccount(actor) {
  const id = String(actor && actor.id || '').trim();
  const name = String(actor && actor.name || '').trim();
  if (!id || !name) return null;
  const user = await store.getUserById(id);
  return user && user.name === name ? user : null;
}

async function permissionAdminAccount(actor) {
  const user = await authorizedAccount(actor);
  return user && user.isPermissionAdmin ? user : null;
}

app.get('/api/health', async (req, res, next) => {
  try {
    // Render probes this endpoint every few seconds. Keep it metadata-only so
    // health checks never transfer the full schedule document from Postgres.
    const state = await store.getMeta();
    res.json({
      ok: true,
      storage: DATABASE_URL ? 'postgres' : 'file',
      revision: state._revision,
      updated: state._updated,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/ping', async (req, res, next) => {
  try {
    const state = await store.getMeta();
    res.json({ _revision: state._revision, _updated: state._updated });
  } catch (error) {
    next(error);
  }
});

app.get('/api/state', async (req, res, next) => {
  try {
    res.json(await store.getState());
  } catch (error) {
    next(error);
  }
});

app.post('/api/state/patch', async (req, res, next) => {
  try {
    const mutationId = String((req.body && req.body.mutationId) || '');
    if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(mutationId)) {
      return res.status(400).json({ ok: false, error: 'invalid mutationId' });
    }
    const changes = normalizeChanges(req.body.changes || []);
    const historyEntries = normalizeHistoryEntries(req.body.historyEntries || []);
    const futureScheduleWeeks = futureScheduleWeeksFromChanges(changes);
    let actor = null;
    if (futureScheduleWeeks.length) {
      actor = await authorizedAccount(req.body && req.body.actor);
      if (!actor || !actor.isPermissionAdmin) {
        return res.status(403).json({
          ok: false,
          error: 'future schedule permission denied',
          deniedWeeks: futureScheduleWeeks,
          user: actor,
          state: await store.getState(),
        });
      }
    }
    const radarFieldChange = changes.some(change => change.path[0] === 'personRadarFields');
    const radarScoreChange = changes.some(change => change.path[0] === 'personRadarScores');
    if (radarFieldChange || radarScoreChange) {
      actor = actor || await authorizedAccount(req.body && req.body.actor);
      const deniedRoots = [];
      if (!actor || (radarFieldChange && !actor.permissions.canManageRadarFields)) {
        if (radarFieldChange) deniedRoots.push('personRadarFields');
      }
      if (!actor || (radarScoreChange && !actor.permissions.canScoreRadar)) {
        if (radarScoreChange) deniedRoots.push('personRadarScores');
      }
      if (deniedRoots.length) {
        return res.status(403).json({
          ok: false,
          error: 'radar permission denied',
          deniedRoots,
          user: actor,
        });
      }
    }
    if (!changes.length && !historyEntries.length) {
      return res.json({ ok: true, state: await store.getState(), duplicate: false });
    }
    if (notificationDispatcher.enabled && historyEntries.length) {
      actor = actor || await authorizedAccount(req.body && req.body.actor);
    }
    const notificationBatches = notificationDispatcher.enabled
      ? extractNotificationBatches({
        mutationId,
        historyEntries,
        actorName: actor && actor.name,
        notifySelf: /^(1|true|yes)$/i.test(process.env.DINGTALK_NOTIFY_SELF || ''),
        targetWeek: currentWeekKeyForShanghai(),
      })
      : [];
    const releaseCandidates = groupNotificationDispatcher.enabled
      ? releaseCandidatesFromHistory(historyEntries, currentWeekKeyForShanghai())
      : [];
    const result = await store.applyPatch({
      mutationId, changes, historyEntries, notificationBatches, releaseCandidates,
    });
    if (result.conflicts.length) {
      return res.status(409).json({
        ok: false,
        error: 'conflict',
        conflicts: result.conflicts,
        state: result.state,
      });
    }
    if (!result.duplicate && notificationBatches.length) {
      notificationDispatcher.wake(DINGTALK_NOTIFY_AGGREGATE_MS);
    }
    if (!result.duplicate && result.groupNotificationWake) {
      groupNotificationDispatcher.wake(DINGTALK_GROUP_RELEASE_DELAY_MS);
    }
    return res.json({ ok: true, state: result.state, duplicate: result.duplicate });
  } catch (error) {
    if (/invalid patch/.test(error.message)) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    return next(error);
  }
});

// 仅兼容新版页面的显式版本写入。无版本的旧页面会被拒绝，避免静默覆盖他人数据。
app.post('/api/state', async (req, res, next) => {
  try {
    if (!Number.isFinite(Number(req.body && req.body._revision))) {
      return res.status(428).json({ ok: false, error: 'revision required', state: await store.getState() });
    }
    const result = await store.replaceState(req.body, Number(req.body._revision));
    if (result.conflict) return res.status(409).json({ ok: false, error: 'conflict', state: result.state });
    return res.json({ ok: true, ...result.state });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/user/identify', async (req, res, next) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name || name.length > 100) return res.status(400).json({ ok: false, error: 'name required' });
    res.json({ ok: true, user: await store.identify(name) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/users', async (req, res, next) => {
  try {
    const actor = await permissionAdminAccount({
      id: req.query.actorId,
      name: req.query.actorName,
    });
    if (!actor) return res.status(403).json({ ok: false, error: 'permission admin required' });
    return res.json({ ok: true, users: await store.listUsers() });
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/admin/users/:id/permissions', async (req, res, next) => {
  try {
    const actor = await permissionAdminAccount(req.body && req.body.actor);
    if (!actor) return res.status(403).json({ ok: false, error: 'permission admin required' });
    const permissions = normalizeAccountPermissions(req.body && req.body.permissions);
    const user = await store.updateUserPermissions(String(req.params.id || ''), permissions);
    if (!user) return res.status(404).json({ ok: false, error: 'user not found' });
    return res.json({ ok: true, user });
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/admin/users/:id', async (req, res, next) => {
  try {
    const actor = await permissionAdminAccount(req.body && req.body.actor);
    if (!actor) return res.status(403).json({ ok: false, error: 'permission admin required' });
    const result = await store.deleteUser(String(req.params.id || ''));
    if (!result) return res.status(404).json({ ok: false, error: 'user not found' });
    if (result.protected) return res.status(409).json({ ok: false, error: 'protected permission admin' });
    return res.json({ ok: true, user: result.user });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/admin/dingtalk-notifications', async (req, res, next) => {
  try {
    const actor = await permissionAdminAccount({ id: req.query.actorId, name: req.query.actorName });
    if (!actor) return res.status(403).json({ ok: false, error: 'permission admin required' });
    const [bindings, recent] = await Promise.all([
      store.listDingTalkBindings(),
      store.listNotificationLogs(30),
    ]);
    return res.json({
      ok: true,
      enabled: notificationDispatcher.enabled,
      configured: dingtalkClient.configured,
      scope: 'current-week',
      aggregateSeconds: Math.round(DINGTALK_NOTIFY_AGGREGATE_MS / 1000),
      bindings,
      recent,
    });
  } catch (error) {
    return next(error);
  }
});

app.put('/api/admin/dingtalk-notifications/bindings/:personId', async (req, res, next) => {
  try {
    const actor = await permissionAdminAccount(req.body && req.body.actor);
    if (!actor) return res.status(403).json({ ok: false, error: 'permission admin required' });
    const personId = String(req.params.personId || '').trim();
    const personName = String(req.body && req.body.personName || '').trim();
    const dingtalkUserId = String(req.body && req.body.dingtalkUserId || '').trim();
    if (!personId || personId.length > 200 || !personName || personName.length > 100) {
      return res.status(400).json({ ok: false, error: 'invalid person' });
    }
    if (!/^[^\s\u0000-\u001f]{1,128}$/.test(dingtalkUserId)) {
      return res.status(400).json({ ok: false, error: 'invalid dingtalk user id' });
    }
    const binding = await store.upsertDingTalkBinding({
      personId,
      personName,
      dingtalkUserId,
      enabled: req.body.enabled !== false,
      updatedBy: actor.name,
    });
    return res.json({ ok: true, binding });
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/admin/dingtalk-notifications/bindings/:personId', async (req, res, next) => {
  try {
    const actor = await permissionAdminAccount(req.body && req.body.actor);
    if (!actor) return res.status(403).json({ ok: false, error: 'permission admin required' });
    await store.deleteDingTalkBinding(String(req.params.personId || ''));
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/internal/group-notifications/daily', async (req, res, next) => {
  try {
    if (!groupNotificationDispatcher.enabled || !GROUP_NOTIFY_CRON_SECRET) {
      return res.status(503).json({ ok: false, error: 'group notification scheduler is not configured' });
    }
    const auth = String(req.get('authorization') || '');
    const suppliedSecret = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!validCronSecret(suppliedSecret)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const now = new Date();
    const parts = shanghaiParts(now);
    if (Number(parts.hour) < 9) {
      return res.status(409).json({ ok: false, error: 'daily notification is only available after 09:00 Asia/Shanghai' });
    }
    const payload = buildDailyVacancyPayload(await store.getState(), now);
    const result = await store.enqueueDailyGroupNotification(payload);
    if (result.inserted && !result.empty) groupNotificationDispatcher.wake(0);
    return res.json({
      ok: true,
      inserted: result.inserted,
      empty: result.empty,
      runDate: payload.runDate,
      dates: payload.items.length,
      vacancies: payload.items.reduce((sum, item) => sum + item.people.length, 0),
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/history/append', async (req, res, next) => {
  try {
    const entries = normalizeHistoryEntries(Array.isArray(req.body) ? req.body : [req.body]);
    res.json({ ok: true, count: await store.appendHistory(entries) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/history', async (req, res, next) => {
  try {
    const historyTag = `W/"history-${store.getHistoryVersion()}"`;
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', historyTag);
    if (req.headers['if-none-match'] === historyTag) return res.status(304).end();
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 500, 1), MAX_HISTORY);
    const history = await store.listHistory({
      group: String(req.query.group || '').trim(),
      user: String(req.query.user || '').trim(),
      query: String(req.query.q || '').trim(),
      limit,
    });
    res.json({ ok: true, history });
  } catch (error) {
    next(error);
  }
});

app.post('/api/history/remove', async (req, res, next) => {
  try {
    const opIds = Array.isArray(req.body && req.body.opIds)
      ? req.body.opIds.map(value => String(value)).filter(Boolean).slice(0, 1000)
      : [];
    res.json({ ok: true, removed: await store.removeHistory(opIds) });
  } catch (error) {
    next(error);
  }
});

// 在线协作状态只保存在当前服务进程内存中，不写数据库、不进入修改历史。
// 浏览器通过心跳续期；页面关闭、断网或服务重启后会自动过期，避免幽灵在线。
app.get('/api/presence', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, editors: getPresenceSnapshot(), ttlMs: PRESENCE_TTL_MS });
});

app.post('/api/presence', (req, res) => {
  try {
    const payload = normalizePresencePayload(req.body);
    const now = Date.now();
    prunePresence(now);

    if (!payload.active) {
      presenceSessions.delete(payload.sessionId);
    } else {
      if (!presenceSessions.has(payload.sessionId) && presenceSessions.size >= MAX_PRESENCE_SESSIONS) {
        return res.status(429).json({ ok: false, error: 'presence capacity reached' });
      }
      presenceSessions.set(payload.sessionId, {
        sessionId: payload.sessionId,
        userName: payload.userName,
        context: payload.context,
        lastSeen: now,
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, editors: getPresenceSnapshot(now), ttlMs: PRESENCE_TTL_MS });
  } catch (error) {
    if (/presence/.test(error.message)) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    return res.status(400).json({ ok: false, error: 'invalid presence payload' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  console.error('[request]', error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ ok: false, error: 'internal error' });
});

let server;
async function start() {
  await store.init();
  await notificationDispatcher.start();
  await groupNotificationDispatcher.start();
  server = app.listen(PORT, () => {
    console.log(`[startup] schedule-app listening on ${PORT}; storage=${DATABASE_URL ? 'postgres' : 'file'}`);
  });
}

async function shutdown(signal) {
  console.log(`[shutdown] ${signal}`);
  notificationDispatcher.close();
  groupNotificationDispatcher.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await store.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  start().catch(error => {
    console.error('[startup]', error);
    process.exit(1);
  });
}

module.exports = {
  app,
  start,
  store,
  editableState,
  normalizeChanges,
  applyChanges,
  normalizePresencePayload,
  prunePresence,
  getPresenceSnapshot,
  presenceSessions,
  isPermissionAdminName,
  scheduleWeekKeyForShanghai,
  currentWeekKeyForShanghai,
  isScheduleWeekOpenForShanghai,
  scheduleWriteBoundaryForShanghai,
  futureScheduleWeeksFromChanges,
  normalizeAccountPermissions,
  FileStore,
  PostgresStore,
  USER_LAST_SEEN_WRITE_INTERVAL_MS,
  DINGTALK_NOTIFY_AGGREGATE_MS,
  notificationDispatcher,
  DINGTALK_GROUP_RELEASE_DELAY_MS,
  groupNotificationDispatcher,
};
