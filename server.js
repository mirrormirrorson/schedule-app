const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { Pool } = require('pg');

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
const EDITABLE_ROOTS = new Set([
  'internalPeople',
  'externalPeople',
  'groups',
  'conditionRules',
  'personRadarFields',
  'personRadarScores',
  'timeOff',
  'weekPeople',
  'weekPeopleLocked',
  'weekGroups',
  'weekGroupLocked',
  'groupColors',
  'schedules',
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

function scheduleWeekKeyForShanghai(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]),
  );
  const localDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const day = localDate.getUTCDay();
  localDate.setUTCDate(localDate.getUTCDate() + (day === 0 ? -6 : 1 - day) + 7);
  return `${localDate.getUTCFullYear()}-${String(localDate.getUTCMonth() + 1).padStart(2, '0')}-${String(localDate.getUTCDate()).padStart(2, '0')}`;
}

function futureScheduleWeeksFromChanges(changes, boundary = scheduleWeekKeyForShanghai()) {
  const weeks = new Set();
  for (const change of changes || []) {
    if (!change || !Array.isArray(change.path) || change.path[0] !== 'schedules') continue;
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
    timeOff: {},
    weekPeople: {},
    schedules: {},
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

  async applyPatch({ mutationId, changes, historyEntries }) {
    return this.withLock(async () => {
      if (this.mutations.has(mutationId)) {
        return { duplicate: true, state: await this.getState(), conflicts: [] };
      }
      const result = applyChanges(this.document, changes);
      if (result.conflicts.length) {
        return { duplicate: false, state: await this.getState(), conflicts: result.conflicts };
      }
      this.document = result.nextData;
      this.history.push(...historyEntries);
      if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
      if (historyEntries.length) this.historyVersion = historyVersionOf(this.history);
      this.revision += 1;
      this.updatedAt = nowIso();
      this.mutations.set(mutationId, this.revision);
      if (this.mutations.size > 5000) this.mutations.delete(this.mutations.keys().next().value);
      await this.persist();
      return { duplicate: false, state: await this.getState(), conflicts: [] };
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

  async applyPatch({ mutationId, changes, historyEntries }) {
    return this.withWriteLock(() => this.applyPatchLocked({ mutationId, changes, historyEntries }));
  }

  async applyPatchLocked({ mutationId, changes, historyEntries }) {
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
        return { duplicate: true, state: cloneJson(currentState), conflicts: [] };
      }
      const result = applyChanges(editableState(currentState), changes);
      if (result.conflicts.length) {
        await client.query('ROLLBACK');
        return { duplicate: false, state: cloneJson(currentState), conflicts: result.conflicts };
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

  getHistoryVersion() {
    return this.historyVersion;
  }
}

const seed = loadSeed();
const store = DATABASE_URL ? new PostgresStore(DATABASE_URL, seed) : new FileStore(seed);

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
    const timeOffChange = changes.some(change => change.path[0] === 'timeOff');
    if (timeOffChange) {
      actor = actor || await authorizedAccount(req.body && req.body.actor);
      if (!actor || !actor.isPermissionAdmin) {
        return res.status(403).json({
          ok: false,
          error: 'time off permission denied',
          user: actor,
          state: await store.getState(),
        });
      }
    }
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
    const result = await store.applyPatch({ mutationId, changes, historyEntries });
    if (result.conflicts.length) {
      return res.status(409).json({
        ok: false,
        error: 'conflict',
        conflicts: result.conflicts,
        state: result.state,
      });
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
  server = app.listen(PORT, () => {
    console.log(`[startup] schedule-app listening on ${PORT}; storage=${DATABASE_URL ? 'postgres' : 'file'}`);
  });
}

async function shutdown(signal) {
  console.log(`[shutdown] ${signal}`);
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
  futureScheduleWeeksFromChanges,
  normalizeAccountPermissions,
  FileStore,
  PostgresStore,
  USER_LAST_SEEN_WRITE_INTERVAL_MS,
};
