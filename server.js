const express = require('express');
// [deploy-force] 触发 Render 重建（内存权威模型已就绪）
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3456;
const DB_PATH = path.join(__dirname, 'data', 'db.json');

// GitHub 仅作为"异步备份"，运行期间服务端内存 db 才是唯一真相
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = 'mirrormirrorson';
const GITHUB_REPO = 'schedule-app';
const GITHUB_FILE = 'data/db.json';
const PUSH_DEBOUNCE = 800; // ms：突发写入合并为一次 GitHub 推送，避免触发限流

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== 权威内存模型 =====
let db = null;
let dbReady = false;

// GitHub 异步推送队列（防抖 + 串行 + 重试），绝不在请求路径里同步推
let pushTimer = null;
let pushing = false;
let pushDirty = false;
let lastSyncSha = null;

// ---------- GitHub 请求 ----------
function ghRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'schedule-app',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      }
    };
    if (body) options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function pullFromGitHub() {
  if (!GITHUB_TOKEN) return null;
  try {
    const apiPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`;
    const result = await ghRequest('GET', apiPath);
    if (result.status === 200 && result.body.content) {
      const content = Buffer.from(result.body.content, 'base64').toString('utf-8');
      const data = JSON.parse(content);
      data._lastSyncSha = result.body.sha;
      return data;
    }
    return null;
  } catch (e) { return null; }
}

// 推送当前内存 db 到 GitHub；409 时拉最新并把我们的 history/users 合并（并集，不丢）再推
async function pushToGitHub(data) {
  const apiPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`;
  const put = async (payload) => {
    const result = await ghRequest('PUT', apiPath, payload);
    if (result.status === 200 || result.status === 201) {
      lastSyncSha = result.body.content.sha;
      return true;
    }
    if (result.status === 409) return false; // 需要合并
    throw new Error('push status ' + result.status);
  };
  const body = {
    message: `[skip render] 数据同步 - ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64')
  };
  if (lastSyncSha) body.sha = lastSyncSha;
  if (await put(body)) return;
  // 冲突：拉最新，并集合并 history/users，再推一次
  const latest = await pullFromGitHub();
  if (!latest) throw new Error('409 后拉取失败');
  lastSyncSha = latest._lastSyncSha || null;
  const merged = mergeKeepAll(data, latest);
  const body2 = {
    message: `[skip render] 数据同步(merge) - ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    content: Buffer.from(JSON.stringify(merged, null, 2)).toString('base64')
  };
  if (lastSyncSha) body2.sha = lastSyncSha;
  if (!(await put(body2))) throw new Error('409 合并后推送仍失败');
}

// 并集合并：以 ours 为基底，history(按 id)/users(按 key) 取并集，绝不丢并发写入
function mergeKeepAll(ours, latest) {
  const m = { ...ours };
  const histMap = new Map();
  (latest.history || []).forEach(h => { if (h.id) histMap.set(h.id, h); });
  (ours.history || []).forEach(h => { if (h.id) histMap.set(h.id, h); });
  m.history = Array.from(histMap.values());
  m.users = { ...(latest.users || {}), ...(ours.users || {}) };
  delete m._lastSyncSha;
  return m;
}

function writeLocal(d) {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH + '.tmp', JSON.stringify(d, null, 2), 'utf-8');
    fs.renameSync(DB_PATH + '.tmp', DB_PATH);
  } catch (e) {}
}

function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(doPush, PUSH_DEBOUNCE);
  if (pushTimer.unref) pushTimer.unref();
}

async function doPush() {
  pushTimer = null;
  if (pushing) { pushDirty = true; return; }
  pushing = true;
  try {
    let attempt = 0;
    while (true) {
      try { await pushToGitHub(db); break; }
      catch (e) {
        attempt++;
        if (attempt >= 4) { console.log('[push] 放弃重试:', e.message); break; }
        await new Promise(r => setTimeout(r, 400 * attempt));
      }
    }
  } finally {
    pushing = false;
    if (pushDirty) { pushDirty = false; schedulePush(); }
  }
}

// ---------- 启动加载（仅一次，之后内存即真相） ----------
async function bootstrap() {
  const g = await pullFromGitHub();
  if (g) { delete g._lastSyncSha; db = g; }
  else {
    try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); }
    catch (e) { db = null; }
  }
  if (!db) db = { internalPeople: [], externalPeople: [], groups: [], schedules: {}, users: {}, history: [], _updated: 0 };
  if (!db.history) db.history = [];
  if (!db.users) db.users = {};
  db._updated = Date.now();
  dbReady = true;
  writeLocal(db);
  schedulePush(); // 把启动快照也备份到 GitHub
  console.log('[startup] 数据已加载，内存模型为运行期唯一真相');
}

// ---------- 写锁：所有对内存 db 的变更串行 ----------
let writeChain = Promise.resolve();
function withLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => {}, () => {});
  return run;
}

// 变更内存 db（权威）→ 触发异步推送；请求立即基于内存返回，不阻塞、不读 GitHub
function mutate(fn) {
  return withLock(async () => {
    const result = await fn(db);
    db._updated = Date.now();
    schedulePush();
    return result;
  });
}

function getDB() { return db; }

// ========================= 路由 =========================
app.get('/api/state', (req, res) => {
  if (!dbReady) return res.status(503).json({ ok: false });
  res.json(getDB());
});

app.get('/api/ping', (req, res) => {
  res.json({ _updated: (db && db._updated) || 0 });
});

// 更新排班/人员状态（不触碰 history/users，服务端权威）
app.post('/api/state', async (req, res) => {
  const nd = req.body || {};
  const m = await mutate(d => {
    ['internalPeople', 'externalPeople', 'groups', 'conditionRules', 'weekPeople', 'schedules']
      .forEach(k => { if (nd[k] !== undefined) d[k] = nd[k]; });
    return d;
  });
  res.json({ ok: true, _updated: m._updated });
});

// 用户身份识别（按真实姓名唯一键）
app.post('/api/user/identify', async (req, res) => {
  const name = ((req.body && req.body.name) || '').toString().trim();
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const user = await mutate(d => {
    if (!d.users) d.users = {};
    const now = new Date().toISOString();
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
    let u = d.users[name];
    if (u) { u.lastSeenAt = now; u.lastIp = ip; }
    else { u = { id: 'u' + Date.now(), name, firstSeenAt: now, lastSeenAt: now, lastIp: ip }; d.users[name] = u; }
    return u;
  });
  res.json({ ok: true, user });
});

// 追加审计历史（与 state 写入同一内存 db，绝不互相覆盖）
app.post('/api/history/append', async (req, res) => {
  const n = await mutate(d => {
    if (!d.history) d.history = [];
    let entries = Array.isArray(req.body) ? req.body : [req.body];
    entries = entries.filter(Boolean).map(e => Object.assign({
      id: 'h' + Date.now() + Math.random().toString(36).slice(2, 7),
      ts: new Date().toISOString()
    }, e));
    d.history = d.history.concat(entries);
    if (d.history.length > 8000) d.history = d.history.slice(-8000);
    return entries.length;
  });
  res.json({ ok: true, count: n });
});

app.get('/api/history', (req, res) => {
  const db = getDB();
  let h = db.history || [];
  const g = req.query.group, u = req.query.user, q = req.query.q;
  if (g) h = h.filter(x => x.group === g || (g === '总览' && (!x.group || x.group === '总览')));
  if (u) h = h.filter(x => x.user === u);
  if (q) {
    const lq = q.toLowerCase();
    h = h.filter(x => [x.content, x.user, x.person, x.group].some(v => (v || '').toLowerCase().includes(lq)));
  }
  h = h.slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const limit = parseInt(req.query.limit, 10) || 500;
  res.json({ ok: true, history: h.slice(0, limit) });
});

// 按 opId 批量删除审计记录（撤销净态对账）
app.post('/api/history/remove', async (req, res) => {
  const removed = await mutate(d => {
    if (!d.history) d.history = [];
    const set = new Set((req.body && req.body.opIds) || []);
    const r = set.size ? d.history.filter(x => x.opId && set.has(x.opId)) : [];
    if (r.length) d.history = d.history.filter(x => !(x.opId && set.has(x.opId)));
    return r;
  });
  res.json({ ok: true, removed });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 优雅关闭：重新部署前把内存最新数据刷回 GitHub，避免丢失窗口内的写入
async function flushNow() {
  if (pushing) { return; }
  try { await pushToGitHub(db); console.log('[shutdown] 已刷盘'); }
  catch (e) { console.log('[shutdown] 刷盘失败:', e.message); }
}
function shutdown(sig) {
  console.log('[shutdown] 收到 ' + sig);
  flushNow().finally(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async function startup() {
  await bootstrap();
  app.listen(PORT, () => console.log(`排班服务器已启动: http://localhost:${PORT}`));
})();
