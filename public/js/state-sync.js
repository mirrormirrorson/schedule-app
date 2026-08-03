// ========================= 数据（本地+远程同步） =========================
const STORAGE_KEY = 'schedule_v4';
const OUTBOX_KEY = 'schedule_outbox_v1';
const CONFLICT_BACKUP_KEY = 'schedule_conflict_backup_v1';
const API_BASE = window.location.origin;
const COLORS = ['#4f46e5','#f59e0b','#10b981','#ef4444','#8b5cf6','#ec4899','#06b6d4','#f97316','#14b8a6','#a855f7','#eab308','#0ea5e9','#d946ef','#22c55e','#f43f5e','#6366f1'];
const DAY_NAMES = ['周一','周二','周三','周四','周五','周六','周日'];

let data = defaultData();
let serverUpdated = 0;
let serverRevision = 0;
let lastServerData = null;
let syncInFlight = false;
let syncRequested = false;
let syncRetryTimer = null;
let pendingHistoryEntries = [];
let inFlightHistoryEntries = [];
let pollingTimer = null;
let saveStatusKind = 'loading';
let currentWeek = null; // 由 bootstrap.js 在全部功能脚本加载后初始化
let activeGroupId = null;
let weekActiveGroup = {}; // 记每周围活跃小组，切回来时恢复
let ovConditionMode = false; // 总览表着色模式：false=按小组, true=按条件

// 选区
let sel = null;        // { r1, c1, r2, c2 }  主选区
let selAnchor = null;
let selDragging = false;
let activeCell = null;
let selExtra = new Set();  // Ctrl+点击追加的单元格 "r,c"

// 编辑
let editing = null;    // { personId, dateStr, el }

// 内部剪贴板
let clipData = null;   // { rows, cols, data: [[val,...],...] }

// 撤销/重做
let undoStack = [];
let redoStack = [];
const MAX_UNDO = 100;

// 填充柄
let fillDragging = false;
let fillStart = null;
let fillEnd = null;

function defaultData() {
  return {
    internalPeople: [],
    externalPeople: [],
    groups: [
      { id:'g1', name:'一组' }, { id:'g2', name:'二组' },
      { id:'g3', name:'三组' }, { id:'g4', name:'四组' },
    ],
    conditionRules: [],
    schedules: {},
  };
}

function setSaveStatus(kind, text) {
  saveStatusKind = kind;
  const el = document.getElementById('saveStatus');
  if (!el) return;
  const labels = {
    loading: '正在读取',
    saving: '正在保存',
    saved: '已保存',
    unsaved: '未保存',
    offline: '未保存（已存本机）',
    conflict: '存在冲突',
  };
  el.className = `save-status ${kind}`;
  el.querySelector('.save-status-text').textContent = text || labels[kind] || '保存状态';
  el.title = kind === 'saved'
    ? '修改已经写入服务器数据库'
    : '请保持页面打开，等待保存完成';
}

function readPersistentOutbox() {
  try {
    const raw = JSON.parse(localStorage.getItem(OUTBOX_KEY));
    if (!raw || raw.version !== 1 || !raw.draftState || !raw.baseState) return null;
    return raw;
  } catch (error) {
    return null;
  }
}

function writePersistentOutbox() {
  if (!lastServerData) return;
  const draftState = editableSnapshot(data);
  const changes = buildPatches(lastServerData, draftState);
  const historyMap = new Map();
  [...pendingHistoryEntries, ...inFlightHistoryEntries].forEach(entry => {
    historyMap.set(entry.id || JSON.stringify(entry), cloneValue(entry));
  });
  const durableHistory = [...historyMap.values()];
  if (!changes.length && !durableHistory.length) {
    localStorage.removeItem(OUTBOX_KEY);
    return;
  }
  localStorage.setItem(OUTBOX_KEY, JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    baseRevision: serverRevision,
    baseState: editableSnapshot(lastServerData),
    draftState,
    historyEntries: durableHistory,
  }));
}

function clearPersistentOutbox() {
  localStorage.removeItem(OUTBOX_KEY);
}

function hasPendingSync() {
  if (syncInFlight || syncRequested || pendingHistoryEntries.length || inFlightHistoryEntries.length) return true;
  if (lastServerData && buildPatches(lastServerData, data).length) return true;
  return Boolean(readPersistentOutbox());
}

function sanitizeServerPayload(raw) {
  const clean = cloneValue(raw || {});
  const revision = Number(clean._revision || 0);
  const updated = Number(clean._updated || 0);
  delete clean.history;
  delete clean.users;
  delete clean._updated;
  delete clean._revision;
  return { state: editableSnapshot(clean), revision, updated };
}

function readSnapshotAtPath(root, path) {
  let current = root;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) {
      return { exists: false };
    }
    current = current[key];
  }
  return { exists: true, value: cloneValue(current) };
}

function snapshotEqual(left, right) {
  return left.exists === right.exists && (!left.exists || valueEqual(left.value, right.value));
}

function rebaseDraft(serverState, baseState, draftState) {
  const intended = buildPatches(baseState, draftState);
  const merged = cloneValue(serverState);
  const conflicts = [];
  intended.forEach(patch => {
    const current = readSnapshotAtPath(merged, patch.path);
    if (snapshotEqual(current, patch.after)) return;
    if (!snapshotEqual(current, patch.before)) {
      conflicts.push({ path: patch.path, server: current, yours: patch.after });
      return;
    }
    applyPatchToData(merged, patch);
  });
  return { intended, merged, conflicts };
}

function storeConflictBackup(state, conflicts) {
  try {
    localStorage.setItem(CONFLICT_BACKUP_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      state: editableSnapshot(state),
      conflicts: conflicts || [],
    }));
  } catch (error) {}
}

function restoreOutboxAgainstServer(serverPayload, outbox) {
  const normalized = sanitizeServerPayload(serverPayload);
  serverRevision = normalized.revision;
  serverUpdated = normalized.updated;
  lastServerData = cloneValue(normalized.state);

  if (!outbox) {
    data = cloneValue(normalized.state);
    pendingHistoryEntries = [];
    clearPersistentOutbox();
    setSaveStatus('saved');
    return;
  }

  pendingHistoryEntries = Array.isArray(outbox.historyEntries)
    ? cloneValue(outbox.historyEntries)
    : [];
  const rebased = rebaseDraft(
    normalized.state,
    editableSnapshot(outbox.baseState),
    editableSnapshot(outbox.draftState),
  );

  if (!rebased.conflicts.length) {
    data = rebased.merged;
    syncRequested = rebased.intended.length > 0 || pendingHistoryEntries.length > 0;
    writePersistentOutbox();
    setSaveStatus(syncRequested ? 'unsaved' : 'saved',
      syncRequested ? '已恢复未提交草稿' : '已保存');
    return;
  }

  storeConflictBackup(outbox.draftState, rebased.conflicts);
  const keepMine = confirm(
    `检测到上次关闭前有 ${rebased.conflicts.length} 处未同步内容，`
    + '同时服务器上已有同事的新修改。\n\n'
    + '点“确定”保留本机草稿并重新提交；点“取消”采用服务器版本。'
  );
  if (keepMine) {
    const forced = cloneValue(normalized.state);
    rebased.intended.forEach(patch => applyPatchToData(forced, patch));
    data = forced;
    syncRequested = true;
    writePersistentOutbox();
    setSaveStatus('unsaved', '已恢复本机草稿');
  } else {
    data = cloneValue(normalized.state);
    pendingHistoryEntries = [];
    clearPersistentOutbox();
    setSaveStatus('saved', '已采用服务器版本');
  }
}

async function loadData() {
  setSaveStatus('loading');
  const outbox = readPersistentOutbox();
  // 先读本地缓存
  try {
    const r = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (r) {
      if (r.people && !r.internalPeople) { r.internalPeople = r.people; r.externalPeople = []; delete r.people; }
      if (!r.internalPeople) r.internalPeople = defaultData().internalPeople;
      if (!r.externalPeople) r.externalPeople = defaultData().externalPeople;
      if (!r.conditionRules) r.conditionRules = [];
      data = r;
    }
  } catch(e) { data = defaultData(); }

  if (outbox && outbox.draftState) {
    data = cloneValue(outbox.draftState);
    lastServerData = editableSnapshot(outbox.baseState);
    pendingHistoryEntries = Array.isArray(outbox.historyEntries)
      ? cloneValue(outbox.historyEntries)
      : [];
    syncRequested = true;
    setSaveStatus('unsaved', '发现未提交草稿');
  }

  // 尝试从服务器加载
  try {
    const res = await fetch(`${API_BASE}/api/state`);
    if (res.ok) {
      restoreOutboxAgainstServer(await res.json(), outbox);
      saveLocal();
    } else {
      throw new Error('state load failed');
    }
  } catch(e) {
    if (!lastServerData) lastServerData = editableSnapshot(data);
    writePersistentOutbox();
    setSaveStatus('offline');
  }

  // 修复历史上被 \u2424 占位符污染的数据
  normalizePlaceholders();
  startPolling();
  if (syncRequested) setTimeout(requestSync, 0);
}

function normalizePlaceholders() {
  let changed = false;
  const rep = s => {
    if (typeof s === 'string' && s.includes('\u2424')) {
      changed = true;
      return s.replace(/\u2424/g, '\n');
    }
    return s;
  };
  if (data.schedules) {
    Object.values(data.schedules).forEach(ws => {
      Object.values(ws).forEach(group => {
        Object.values(group).forEach(entries => {
          if (Array.isArray(entries)) {
            entries.forEach(e => {
              if (e && e.note !== undefined) e.note = rep(e.note);
            });
          }
        });
      });
    });
  }
  if (changed) saveData();
}

function saveData() {
  saveLocal();
  setSaveStatus(navigator.onLine ? 'saving' : 'offline');
  writePersistentOutbox();
  requestSync();
}

function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

const EDITABLE_ROOTS = [
  'internalPeople', 'externalPeople', 'groups', 'conditionRules',
  'personRadarFields', 'personRadarScores',
  'weekPeople', 'weekPeopleLocked', 'weekGroups', 'weekGroupLocked',
  'groupColors', 'schedules', 'resolutions'
];

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function editableSnapshot(source) {
  const result = {};
  EDITABLE_ROOTS.forEach(key => {
    if (source && source[key] !== undefined) result[key] = cloneValue(source[key]);
  });
  return result;
}

function valueEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => valueEqual(value, right[index]));
  }
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && valueEqual(left[key], right[key]));
  }
  return false;
}

function makeSnapshot(exists, value) {
  return exists ? { exists: true, value: cloneValue(value) } : { exists: false };
}

// 对象递归到叶子，数组（包括单元格 entries）按一个原子值处理。
function buildPatches(beforeRoot, afterRoot) {
  const patches = [];
  function walk(beforeExists, before, afterExists, after, path) {
    if (beforeExists && afterExists && valueEqual(before, after)) return;
    const bothPlainObjects = beforeExists && afterExists
      && before && after
      && typeof before === 'object' && typeof after === 'object'
      && !Array.isArray(before) && !Array.isArray(after);
    if (bothPlainObjects) {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      keys.forEach(key => {
        walk(
          Object.prototype.hasOwnProperty.call(before, key), before[key],
          Object.prototype.hasOwnProperty.call(after, key), after[key],
          path.concat(key)
        );
      });
      return;
    }
    patches.push({
      path,
      before: makeSnapshot(beforeExists, before),
      after: makeSnapshot(afterExists, after)
    });
  }
  const before = editableSnapshot(beforeRoot || {});
  const after = editableSnapshot(afterRoot || {});
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.forEach(key => {
    walk(
      Object.prototype.hasOwnProperty.call(before, key), before[key],
      Object.prototype.hasOwnProperty.call(after, key), after[key],
      [key]
    );
  });
  return patches;
}

function applyPatchToData(target, patch) {
  let current = target;
  for (let index = 0; index < patch.path.length - 1; index++) {
    const key = patch.path[index];
    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) current[key] = {};
    current = current[key];
  }
  const leaf = patch.path[patch.path.length - 1];
  if (patch.after.exists) current[leaf] = cloneValue(patch.after.value);
  else delete current[leaf];
}

function newMutationId() {
  if (window.crypto && window.crypto.randomUUID) return `m_${window.crypto.randomUUID()}`;
  return `m_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function requestSync() {
  syncRequested = true;
  writePersistentOutbox();
  setSaveStatus(navigator.onLine ? 'saving' : 'offline');
  if (syncRetryTimer) {
    clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
  }
  drainSyncQueue();
}

async function handleSyncConflict(payload, sentHistory) {
  const serverState = editableSnapshot(payload.state || {});
  const localState = editableSnapshot(data);
  storeConflictBackup(localState, payload.conflicts || []);
  setSaveStatus('conflict');

  const count = (payload.conflicts || []).length;
  const keepMine = confirm(
    `检测到 ${count || 1} 处内容在你编辑期间已被同事修改。\n\n`
    + '为避免静默覆盖，系统已暂停保存并在本机保留了你的版本。\n'
    + '点“确定”保留我的修改；点“取消”采用服务器上的同事版本。'
  );

  serverRevision = Number((payload.state && payload.state._revision) || serverRevision);
  serverUpdated = Number((payload.state && payload.state._updated) || Date.now());
  lastServerData = cloneValue(serverState);

  if (keepMine) {
    pendingHistoryEntries = sentHistory.concat(pendingHistoryEntries);
    syncRequested = true;
    writePersistentOutbox();
    setSaveStatus('saving');
  } else {
    data = cloneValue(serverState);
    pendingHistoryEntries = [];
    saveLocal();
    clearPersistentOutbox();
    setSaveStatus('saved', '已采用服务器版本');
    renderAll();
    toast('已采用服务器版本');
  }
}

async function drainSyncQueue() {
  if (syncInFlight || !lastServerData) return;
  syncInFlight = true;
  setSaveStatus('saving');
  try {
    while (syncRequested) {
      syncRequested = false;
      const sentData = editableSnapshot(data);
      const changes = buildPatches(lastServerData, sentData);
      const sentHistory = pendingHistoryEntries.splice(0);
      inFlightHistoryEntries = cloneValue(sentHistory);
      if (!changes.length && !sentHistory.length) {
        clearPersistentOutbox();
        setSaveStatus('saved');
        continue;
      }
      writePersistentOutbox();

      let res;
      try {
        res = await fetch(`${API_BASE}/api/state/patch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mutationId: newMutationId(),
            changes,
            historyEntries: sentHistory,
            actor: typeof currentUser !== 'undefined' && currentUser
              ? { id: currentUser.id, name: currentUser.name }
              : null
          })
        });
      } catch (error) {
        pendingHistoryEntries = sentHistory.concat(pendingHistoryEntries);
        inFlightHistoryEntries = [];
        throw error;
      }

      const payload = await res.json().catch(() => ({}));
      if (res.status === 409) {
        inFlightHistoryEntries = [];
        await handleSyncConflict(payload, sentHistory);
        continue;
      }
      if (res.status === 403 && payload.error === 'radar permission denied') {
        inFlightHistoryEntries = [];
        pendingHistoryEntries = sentHistory.concat(pendingHistoryEntries);
        const deniedRoots = new Set(Array.isArray(payload.deniedRoots) ? payload.deniedRoots : []);
        deniedRoots.forEach(root => {
          if (!lastServerData || !Object.prototype.hasOwnProperty.call(lastServerData, root)) delete data[root];
          else data[root] = cloneValue(lastServerData[root]);
        });
        if (typeof currentUser !== 'undefined' && currentUser) {
          currentUser = payload.user || {
            ...currentUser,
            isPermissionAdmin: false,
            permissions: { canScoreRadar: false, canManageRadarFields: false },
          };
          if (typeof renderGreeting === 'function') renderGreeting();
        }
        saveLocal();
        if (!editing) renderAll();
        if (typeof renderManageTab === 'function') renderManageTab();
        toast('权限已变更，未授权的雷达修改没有保存');
        syncRequested = pendingHistoryEntries.length > 0
          || (lastServerData && buildPatches(lastServerData, data).length > 0);
        if (!syncRequested) {
          clearPersistentOutbox();
          setSaveStatus('saved', '未授权修改已撤回');
        } else {
          writePersistentOutbox();
        }
        continue;
      }
      if (!res.ok || !payload.state) {
        pendingHistoryEntries = sentHistory.concat(pendingHistoryEntries);
        inFlightHistoryEntries = [];
        throw new Error(payload.error || 'save failed');
      }
      inFlightHistoryEntries = [];

      const latestLocal = editableSnapshot(data);
      const unsentChanges = buildPatches(sentData, latestLocal);
      const serverState = editableSnapshot(payload.state);
      const remoteChanges = buildPatches(sentData, serverState);
      lastServerData = cloneValue(serverState);
      data = cloneValue(serverState);
      unsentChanges.forEach(patch => applyPatchToData(data, patch));
      serverRevision = Number(payload.state._revision || serverRevision);
      serverUpdated = Number(payload.state._updated || Date.now());
      saveLocal();

      if (remoteChanges.length && !editing) renderAll();
      if (unsentChanges.length || pendingHistoryEntries.length) {
        syncRequested = true;
        writePersistentOutbox();
      } else {
        clearPersistentOutbox();
        setSaveStatus('saved');
      }
    }
  } catch (error) {
    toast('网络异常，修改已保存在本机，正在重试');
    writePersistentOutbox();
    setSaveStatus('offline');
    syncRequested = true;
    syncRetryTimer = setTimeout(() => {
      syncRetryTimer = null;
      drainSyncQueue();
    }, 3000);
  } finally {
    syncInFlight = false;
    if (!syncRequested && !pendingHistoryEntries.length
      && lastServerData && !buildPatches(lastServerData, data).length) {
      clearPersistentOutbox();
      setSaveStatus('saved');
    }
    if (syncRequested && !syncRetryTimer) drainSyncQueue();
  }
}

function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/ping`);
      if (res.ok) {
        const { _updated, _revision } = await res.json();
        if (saveStatusKind === 'offline' && !hasPendingSync()) setSaveStatus('saved');
        if ((_revision || 0) > serverRevision && !syncInFlight && buildPatches(lastServerData, data).length === 0) {
          const full = await fetch(`${API_BASE}/api/state`);
          if (full.ok) {
            restoreOutboxAgainstServer(await full.json(), readPersistentOutbox());
            saveLocal();
            renderAll();
            if (syncRequested) requestSync();
          }
        }
      }
    } catch(e) {
      if (hasPendingSync()) setSaveStatus('offline');
    }
  }, 3000);
}

window.addEventListener('online', () => {
  if (hasPendingSync()) {
    setSaveStatus('saving');
    requestSync();
  }
});

window.addEventListener('offline', () => {
  if (hasPendingSync()) setSaveStatus('offline');
});

window.addEventListener('beforeunload', event => {
  if (!hasPendingSync()) return;
  writePersistentOutbox();
  event.preventDefault();
  event.returnValue = '';
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && hasPendingSync()) writePersistentOutbox();
});
