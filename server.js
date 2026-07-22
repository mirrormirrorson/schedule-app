const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3456;
const DB_PATH = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 读取数据库
function readDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { internalPeople:[], externalPeople:[], groups:[], schedules:{}, resolutions:{}, _updated: 0 };
  }
}

// 写入数据库
function writeDB(data) {
  data._updated = Date.now();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH + '.tmp', JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(DB_PATH + '.tmp', DB_PATH);
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
  // 这样可以避免不同用户覆盖彼此的 group 数据
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
      // 删除合并数据中新数据已移除的 group
      Object.keys(merged.schedules[week]).forEach(groupId => {
        if (!newData.schedules[week][groupId]) delete merged.schedules[week][groupId];
      });
      // 更新新数据中的 group
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

app.listen(PORT, () => {
  console.log(`排班服务器已启动: http://localhost:${PORT}`);
});
