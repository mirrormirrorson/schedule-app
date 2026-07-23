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

// 从 GitHub 拉取最新 db.json
async function pullFromGitHub() {
  if (!GITHUB_TOKEN) {
    console.log('GITHUB_TOKEN 未配置，使用本地文件');
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
    console.log('GitHub 拉取失败，使用本地文件:', result.status);
    return null;
  } catch (e) {
    console.log('GitHub 拉取异常:', e.message);
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
      message: `数据同步 - ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      content: base64
    };

    // 如果知道 sha，使用它避免冲突
    if (lastSyncSha) body.sha = lastSyncSha;

    const result = await ghRequest('PUT', apiPath, body);
    if (result.status === 200 || result.status === 201) {
      lastSyncSha = result.body.content.sha;
      console.log('GitHub 同步成功');
    } else if (result.status === 409) {
      // 冲突了，先拉取再推送
      console.log('GitHub 冲突，重新拉取后推送...');
      const latest = await pullFromGitHub();
      if (latest) {
        // 合并：本地数据覆盖 GitHub（本地更新）
        const merged = { ...data, _lastSyncSha: latest._lastSyncSha };
        delete merged._lastSyncSha;
        saving = false;
        // 递归重试一次
        await syncToGitHub(merged);
        return;
      }
      console.log('GitHub 冲突解决失败');
    } else {
      console.log('GitHub 同步失败:', result.status, result.body.message || '');
    }
  } catch (e) {
    console.log('GitHub 同步异常:', e.message);
  }
  saving = false;
}

// 读取数据库
function readDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { internalPeople:[], externalPeople:[], groups:[], schedules:{}, resolutions:{}, _updated: 0 };
  }
}

// 写入数据库 + 同步到 GitHub
function writeDB(data) {
  data._updated = Date.now();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH + '.tmp', JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(DB_PATH + '.tmp', DB_PATH);
  // 异步同步到 GitHub，不阻塞响应
  syncToGitHub(data);
}

// 获取完整状态
app.get('/api/state', (req, res) => {
  res.json(readDB());
});

// 更新完整状态
app.post('/api/state', (req, res) => {
  const oldData = readDB();
  const newData = req.body;

  // 合并策略：取各 group 的 schedules，新数据覆盖对应 group
  const merged = { ...oldData };

  // 元信息始终用最新的
  if (newData.internalPeople) merged.internalPeople = newData.internalPeople;
  if (newData.externalPeople) merged.externalPeople = newData.externalPeople;
  if (newData.groups) merged.groups = newData.groups;
  if (newData.resolutions) merged.resolutions = newData.resolutions;
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

  writeDB(merged);
  res.json({ ok: true, _updated: merged._updated });
});

// 获取更新时间戳（用于轮询）
app.get('/api/ping', (req, res) => {
  const db = readDB();
  res.json({ _updated: db._updated || 0 });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动时从 GitHub 拉取最新数据
(async function startup() {
  const ghData = await pullFromGitHub();
  if (ghData) {
    lastSyncSha = ghData._lastSyncSha || null;
    const cleanData = { ...ghData };
    delete cleanData._lastSyncSha;
    writeDB(cleanData);
    console.log('已从 GitHub 加载最新数据');
  }
  app.listen(PORT, () => {
    console.log(`排班服务器已启动: http://localhost:${PORT}`);
  });
})();
