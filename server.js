const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3456;
const DB_PATH = path.join(__dirname, 'data', 'db.json');

// GitHub 同步配置
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = 'mirrormirrorson';
const GITHUB_REPO = 'schedule-app';
const GITHUB_FILE = 'data/db.json';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 内存缓存：作为快速读源。GitHub 始终是权威真相源。
let dbCache = null;

// GitHub API 请求辅助
function ghRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: apiPath,
      method: method,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'schedule-app',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      const json = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(json);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 从 GitHub 拉取最新 db.json（返回最新数据或 null）
async function pullFromGitHub() {
  if (!GITHUB_TOKEN) {
    return null;
  }
  try {
    const apiPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`;
    const result = await ghRequest('GET', apiPath);
    if (result.status === 200 && result.body.content) {
      const content = Buffer.from(result.body.content, 'base64').toString('utf-8');
      const data = JSON.parse(content);
      data._lastSyncSha = result.body.sha; // 记住 sha 用于后续推送
      return data;
    }
    console.log('[sync] GitHub 拉取返回非 200:', result.status);
    return null;
  } catch (e) {
    console.log('[sync] GitHub 拉取异常:', e.message);
    return null;
  }
}

// 同步 db.json 到 GitHub
let lastSyncSha = null;
let saving = false;

async function syncToGitHub(data) {
  if (!GITHUB_TOKEN) return;
  saving = true;
  try {
    const content = JSON.stringify(data, null, 2);
    const base64 = Buffer.from(content).toString('base64');
    const apiPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`;

    const body = {
      message: `[skip render] 数据同步 - ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      content: base64
    };

    // 如果知道 sha，使用它避免冲突
    if (lastSyncSha) body.sha = lastSyncSha;

    const result = await ghRequest('PUT', apiPath, body);
    if (result.status === 200 || result.status === 201) {
      lastSyncSha = result.body.content.sha;
      console.log('[sync] GitHub 同步成功');
    } else if (result.status === 409) {
      // 冲突了，先拉取再推送
      console.log('[sync] GitHub 冲突，重新拉取后推送...');
      const latest = await pullFromGitHub();
      if (latest) {
        const merged = { ...data, _lastSyncSha: latest._lastSyncSha };
        delete merged._lastSyncSha;
        saving = false;
        await syncToGitHub(merged);
        return;
      }
      console.log('[sync] GitHub 冲突解决失败');
    } else {
      console.log('[sync] GitHub 同步失败:', result.status, (result.body && result.body.message) || '');
    }
  } catch (e) {
    console.log('[sync] GitHub 同步异常:', e.message);
  }
  saving = false;
}

// 读取数据库（本地文件兜底）
function readDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { internalPeople:[], externalPeople:[], groups:[], schedules:{}, users:{}, history:[], _updated: 0 };
  }
}

// 写入数据库 + 同步到 GitHub
function writeDB(data) {
  data._updated = Date.now();
  dbCache = data; // 立即更新读缓存，避免读旧
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH + '.tmp', JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(DB_PATH + '.tmp', DB_PATH);
  // 异步同步到 GitHub，不阻塞响应
  syncToGitHub(data);
}

// 取最新数据：优先 GitHub（权威），失败则回退缓存/本地。用于写操作前取基线。
async function latestDB() {
  const g = await pullFromGitHub();
  if (g) { dbCache = g; return g; }
  return dbCache || readDB();
}

// 读缓存（快速读源，后台定时刷新）
function getDB() {
  return dbCache || readDB();
}

// 获取完整状态
app.get('/api/state', (req, res) => {
  res.json(getDB());
});

// 更新完整状态
app.post('/api/state', async (req, res) => {
  const oldData = await latestDB();   // 以 GitHub 最新为基线，避免覆盖他人修改
  const newData = req.body;

  // 合并策略：取各 group 的 schedules，新数据覆盖对应 group
  const merged = { ...oldData };

  // 元信息始终用最新的
  if (newData.internalPeople) merged.internalPeople = newData.internalPeople;
  if (newData.externalPeople) merged.externalPeople = newData.externalPeople;
  if (newData.groups) merged.groups = newData.groups;
  if (newData.conditionRules) merged.conditionRules = newData.conditionRules;
  if (newData.weekPeople) merged.weekPeople = newData.weekPeople;

  // schedules 合并：取新数据中该周的 group 列表，删除旧数据中不再存在的 group
  if (newData.schedules) {
    if (!merged.schedules) merged.schedules = {};
    Object.keys(newData.schedules).forEach(week => {
      if (!merged.schedules[week]) merged.schedules[week] = {};
      Object.keys(merged.schedules[week]).forEach(groupId => {
        if (!newData.schedules[week][groupId]) delete merged.schedules[week][groupId];
      });
      Object.keys(newData.schedules[week]).forEach(groupId => {
        merged.schedules[week][groupId] = newData.schedules[week][groupId];
      });
    });
  }

  // 用户身份与审计历史：服务端权威，不被整份 state 覆盖（由专属接口写入）
  if (oldData.users) merged.users = oldData.users;
  if (oldData.history) merged.history = oldData.history;

  writeDB(merged);
  res.json({ ok: true, _updated: merged._updated });
});

// 获取更新时间戳（用于轮询）
app.get('/api/ping', (req, res) => {
  const db = getDB();
  res.json({ _updated: db._updated || 0 });
});

// ========================= 用户身份 & 审计历史 =========================

// 按"真实姓名"为唯一键识别用户（换设备输入同名 = 登录原身份，不新建）
app.post('/api/user/identify', async (req, res) => {
  const name = (req.body && req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const db = await latestDB();
  if (!db.users) db.users = {};
  const now = new Date().toISOString();
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  let user = db.users[name];
  if (user) {
    user.lastSeenAt = now;
    user.lastIp = ip;
  } else {
    user = { id: 'u' + Date.now(), name, firstSeenAt: now, lastSeenAt: now, lastIp: ip };
    db.users[name] = user;
  }
  writeDB(db);
  res.json({ ok: true, user });
});

// 追加审计历史（支持单条或数组），服务端原子写入 + 同步 GitHub
app.post('/api/history/append', async (req, res) => {
  const db = await latestDB();
  if (!db.history) db.history = [];
  let entries = Array.isArray(req.body) ? req.body : [req.body];
  entries = entries.filter(Boolean).map(e => Object.assign({
    id: 'h' + Date.now() + Math.random().toString(36).slice(2, 7),
    ts: new Date().toISOString(),
  }, e));
  db.history = db.history.concat(entries);
  if (db.history.length > 8000) db.history = db.history.slice(-8000); // 上限保护，避免无限膨胀
  writeDB(db);
  res.json({ ok: true, count: entries.length });
});

// 读取审计历史（按组 / 用户 / 关键词筛选，倒序返回）
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

// 按操作批次(opId)删除审计记录（用于撤销的净态对账：撤销即移除对应记录）
app.post('/api/history/remove', async (req, res) => {
  const db = await latestDB();
  if (!db.history) db.history = [];
  const opIds = (req.body && req.body.opIds) || [];
  const set = new Set(opIds);
  const removed = set.size ? db.history.filter(x => x.opId && set.has(x.opId)) : [];
  if (removed.length) {
    db.history = db.history.filter(x => !(x.opId && set.has(x.opId)));
    writeDB(db);
  }
  res.json({ ok: true, removed });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动时从 GitHub 拉取最新数据（失败重试，不静默回退到陈旧本地文件）
async function startupPull(retries = 5, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    const ghData = await pullFromGitHub();
    if (ghData) {
      lastSyncSha = ghData._lastSyncSha || null;
      const cleanData = { ...ghData };
      delete cleanData._lastSyncSha;
      dbCache = cleanData;
      writeDB(cleanData); // 写本地缓存 + 同步
      console.log('[startup] 已从 GitHub 加载最新数据 (try ' + (i + 1) + ')');
      return true;
    }
    console.log(`[startup] 第 ${i + 1} 次拉取失败，${i < retries - 1 ? '重试中...' : '放弃，使用本地文件'}`);
    if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
  }
  // 全部失败：尽量用本地文件，但标记告警
  const local = readDB();
  dbCache = local;
  console.log('[startup][ERROR] GitHub 拉取全部失败，已回退本地文件（数据可能不是最新！）');
  return false;
}

// 后台保活：每 30s 从 GitHub 刷新读缓存，保持本地与云端一致
setInterval(async () => {
  const g = await pullFromGitHub();
  if (g) {
    lastSyncSha = g._lastSyncSha || lastSyncSha;
    const clean = { ...g };
    delete clean._lastSyncSha;
    dbCache = clean;
  }
}, 30000).unref();

(async function startup() {
  await startupPull();
  app.listen(PORT, () => {
    console.log(`排班服务器已启动: http://localhost:${PORT}`);
  });
})();
