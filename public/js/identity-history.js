// ========================= 启动 =========================
// ========================= 3.0: 用户身份 & 审计历史 =========================
let currentUser = null;
const USER_KEY = 'schedule_user_v1';

function userName() { return (currentUser && currentUser.name) || '匿名'; }

function appendHistory(entries) {
  if (!entries || !entries.length) return;
  pendingHistoryEntries.push(...entries.map(entry => {
    const item = cloneValue(entry);
    if (!item.id) item.id = `h_${newMutationId()}`;
    return item;
  }));
  requestSync();
}

function resolvePersonName(pid) {
  if (!pid) return '';
  let p = (data.internalPeople || []).find(x => x.id === pid) || (data.externalPeople || []).find(x => x.id === pid);
  if (!p && data.weekPeople) {
    for (const arr of Object.values(data.weekPeople)) {
      const f = arr.find(x => x.id === pid);
      if (f) { p = f; break; }
    }
  }
  return p ? p.name : (pid || '');
}

function resolveGroupName(gid) {
  if (!gid || gid === '__overview__') return '总览';
  const g = (data.groups || []).find(x => x.id === gid) || (weekGroups().find(x => x.id === gid));
  return g ? g.name : '未知组';
}

function summarizeEntries(entries) {
  if (!entries || !entries.length) return '';
  return entries.map(e => {
    if (!e) return '';
    if (e.note != null) return e.note;
    if (e.blockData) return '[多块]';
    return '';
  }).filter(Boolean).join(' / ');
}

function weekdayName(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}

function logChanges(changes, opId, opMeta) {
  if (!changes || !changes.length) return;
  const week = wsKey();
  let entries;
  if (opMeta && opMeta.type === 'move') {
    // 拖拽 = 一次移动，合并为单条记录
    const fromLabel = `${resolvePersonName(opMeta.fromPerson)}·${weekdayName(opMeta.fromDate)}`;
    const toLabel = `${resolvePersonName(opMeta.toPerson)}·${weekdayName(opMeta.toDate)}`;
    entries = [{
      user: userName(),
      ts: new Date().toISOString(),
      week,
      group: resolveGroupName(opMeta.groupId),
      person: '', date: '', weekday: '',
      action: 'move',
      content: opMeta.content || '',
      fromLabel, toLabel,
      groupId: opMeta.groupId || '',
      fromPersonId: opMeta.fromPerson || '',
      fromDate: opMeta.fromDate || '',
      toPersonId: opMeta.toPerson || '',
      toDate: opMeta.toDate || '',
      opId
    }];
  } else {
    entries = changes.map(ch => {
      const oldV = ch.oldVal || [], newV = ch.newVal || [];
      const had = oldV.length > 0, has = newV.length > 0;
      let action = 'modify';
      if (!had && has) action = 'add';
      else if (had && !has) action = 'delete';
      const gid = ch.groupId || activeGroupId;
      const dateStr = ch.dateStr || '';
      return {
        user: userName(),
        ts: new Date().toISOString(),
        week,
        group: resolveGroupName(gid),
        groupId: gid,
        person: resolvePersonName(ch.personId),
        personId: ch.personId,
        date: dateStr,
        weekday: weekdayName(dateStr),
        action,
        content: (action === 'delete') ? summarizeEntries(oldV) : summarizeEntries(newV),
        detail: { old: summarizeEntries(oldV), new: summarizeEntries(newV) },
        opId
      };
    });
  }
  appendHistory(entries);
}

function logPersonAction(action, personName, scope = 'template', meta = {}) {
  const isWeekScope = scope === 'week';
  appendHistory([{
    user: userName(), ts: new Date().toISOString(), week: wsKey(),
    group: isWeekScope ? '本周人员名单' : '常用人员模板',
    personScope: isWeekScope ? 'week' : 'template',
    personCategory: meta.category || '',
    person: personName, action, content: personName,
    detail: meta.detail || null,
    date: '', weekday: ''
  }]);
}

// ---- 用户身份 ----
async function identifyUser(name) {
  const res = await fetch(`${API_BASE}/api/user/identify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
  });
  if (!res.ok) throw new Error('identify failed');
  const r = await res.json();
  return r.user;
}

function renderGreeting() {
  const el = document.getElementById('userGreeting');
  if (el) el.textContent = (currentUser ? currentUser.name : '') + '，您好';
  if (typeof presenceIdentityChanged === 'function') presenceIdentityChanged();
  if (typeof updatePermissionTabVisibility === 'function') updatePermissionTabVisibility();
}

// 点击问候栏弹出用户菜单（切换用户）
function openUserMenu() {
  if (document.getElementById('userMenu')) { closeUserMenu(); return; }
  const g = document.getElementById('userGreeting');
  const rect = g.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.id = 'userMenu';
  menu.style.cssText = 'position:fixed;z-index:720;background:var(--card);border:1.5px solid var(--border);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:6px;min-width:160px;';
  menu.style.top = (rect.bottom + 8) + 'px';
  menu.style.left = Math.max(8, rect.right - 168) + 'px';
  menu.innerHTML = `
    <div style="font-size:12px;color:var(--text2);padding:6px 10px 8px;">当前：${esc(currentUser ? currentUser.name : '未登录')}</div>
    <button class="btn btn-p" style="width:100%;font-size:13px;justify-content:flex-start;" onclick="closeUserMenu();showIdentityModal()">🔄 切换用户</button>`;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', outsideCloseUserMenu), 0);
}
function outsideCloseUserMenu(e) {
  const m = document.getElementById('userMenu');
  if (m && !m.contains(e.target) && e.target.id !== 'userGreeting') closeUserMenu();
}
function closeUserMenu() {
  const m = document.getElementById('userMenu');
  if (m) m.remove();
  document.removeEventListener('click', outsideCloseUserMenu);
}

function showIdentityModal(forced = false) {
  if (document.getElementById('identityModal')) return;
  const overlay = document.createElement('div');
  overlay.id = 'identityModal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:700;' + (forced ? 'cursor:default;' : '');
  overlay.innerHTML = `
    <div class="id-card">
      <div class="id-title">👋 欢迎使用视频排班</div>
      <div class="id-sub">首次使用，请填写你的真实姓名，用于记录每一次排班修改（换设备输入同名将自动登录原身份）。</div>
      <input id="identityNameInput" placeholder="请输入真实姓名" />
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px;">
        <button class="btn btn-p" id="identityConfirm">确定</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const inp = overlay.querySelector('#identityNameInput');
  inp.focus();
  const doConfirm = async () => {
    const name = (inp.value || '').trim();
    if (!name) { inp.style.borderColor = '#ef4444'; return; }
    try {
      const u = await identifyUser(name);
      currentUser = u;
      localStorage.setItem(USER_KEY, name);
      renderGreeting();
      overlay.remove();
    } catch (e) { alert('提交失败，请重试'); }
  };
  overlay.querySelector('#identityConfirm').addEventListener('click', doConfirm);
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); doConfirm(); }
    if (e.key === 'Escape') { e.preventDefault(); if (!forced) overlay.remove(); }
  });
  // 强制模式下禁止点击遮罩关闭（避免匿名账户，无法追溯谁改过排班）
  if (!forced) {
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
  }
}

async function initIdentity() {
  const saved = localStorage.getItem(USER_KEY);
  if (saved) {
    try {
      const u = await identifyUser(saved);
      if (u) { currentUser = u; renderGreeting(); return; }
    } catch (e) {}
  }
  showIdentityModal(true);
}

// ---- 修改记录抽屉 ----
const ACTION_LABEL = { add: '新增', modify: '修改', delete: '删除', move: '移动', leaveSet: '设置休假', leaveClear: '取消休假', addPerson: '新增人员', renamePerson: '改名', removePerson: '删除人员', removeFromWeek: '移除本周' };
const PERSON_ACTIONS = new Set(['addPerson', 'renamePerson', 'removePerson', 'removeFromWeek']);
let historyOpenContext = null;
let historyCellContext = null;

function isPersonHistory(entry) {
  return PERSON_ACTIONS.has(entry && entry.action);
}

function personHistoryScope(entry) {
  if (!isPersonHistory(entry)) return '';
  if (entry.personScope === 'week'
    || entry.group === '本周'
    || entry.group === '本周人员名单'
    || entry.action === 'removeFromWeek') return 'week';
  return 'template';
}

function historyAreaKey(entry) {
  const scope = personHistoryScope(entry);
  if (scope === 'week') return '__people_week__';
  if (scope === 'template') return '__people_template__';
  return (entry && entry.group) || '';
}

function historyAreaLabel(entry) {
  const scope = personHistoryScope(entry);
  if (scope === 'week') return '本周人员名单';
  if (scope === 'template') return '常用人员模板';
  return (entry && entry.group) || '未分组';
}

function personCategoryLabel(entry) {
  if (entry.personCategory === 'internal') return '内部人员';
  if (entry.personCategory === 'external') return '外协人员';
  return '';
}

function updateHistoryCellFilterUI() {
  const banner = document.getElementById('historyCellFilter');
  const groupFilter = document.getElementById('historyGroupFilter');
  const weekFilter = document.getElementById('historyWeekFilter');
  if (!banner || !groupFilter || !weekFilter) return;
  const active = Boolean(historyCellContext);
  groupFilter.disabled = active;
  weekFilter.disabled = active;
  if (!active) {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }
  const context = historyCellContext;
  const area = context.overview ? '总览（全部小组）' : context.group;
  banner.style.display = 'flex';
  banner.innerHTML = `<span><strong>当前单元格内容</strong> · ${esc(context.person)} · ${esc(context.date)} ${esc(context.weekday)} · ${esc(area)}</span>
    <button type="button" onclick="clearCellHistoryFilter()">退出单元格筛选</button>`;
}

function clearCellHistoryFilter() {
  historyCellContext = null;
  updateHistoryCellFilterUI();
  renderHistoryList();
}

function showHistoryDrawer() {
  buildHistoryGroupFilter();
  document.getElementById('historyOverlay').classList.add('open');
  document.getElementById('historyDrawer').classList.add('open');
  loadAllHistory(true);
  if (historyRefreshTimer) clearInterval(historyRefreshTimer);
  historyRefreshTimer = setInterval(() => {
    if (!document.hidden && document.getElementById('historyDrawer').classList.contains('open')) loadAllHistory();
  }, 60000);
}

function openHistoryDrawer() {
  const currentGroup = activeGroupId && activeGroupId !== '__overview__'
    ? resolveGroupName(activeGroupId)
    : '';
  historyCellContext = null;
  updateHistoryCellFilterUI();
  historyOpenContext = { week: wsKey(), group: currentGroup };
  showHistoryDrawer();
}

function openCellHistoryDrawer(context) {
  historyCellContext = context;
  historyOpenContext = { week: context.week, group: context.group || '' };
  const search = document.getElementById('historySearch');
  const groupFilter = document.getElementById('historyGroupFilter');
  const weekFilter = document.getElementById('historyWeekFilter');
  if (search) search.value = '';
  // 单元格自身已经包含精确周/组/人员/日期，先清掉旧的手动筛选，避免叠加后误判为无记录。
  if (groupFilter) groupFilter.value = '';
  if (weekFilter) weekFilter.value = '';
  updateHistoryCellFilterUI();
  showHistoryDrawer();
}

function closeHistoryDrawer() {
  if (historyRefreshTimer) { clearInterval(historyRefreshTimer); historyRefreshTimer = null; }
  document.getElementById('historyOverlay').classList.remove('open');
  document.getElementById('historyDrawer').classList.remove('open');
}

// 周标注：本周 / 排班周（=当前编辑周）始终标注，未来周仅在有数据时出现在筛选里
function weekLabelOf(wk) {
  if (!wk) return '—';
  const thisWeekKey = fmtFull(getMonday(new Date()));
  const scheduleWeekKey = fmtFull(getMonday(new Date(Date.now() + 7 * 86400000)));
  const start = new Date(wk + 'T00:00:00');
  const end = new Date(start.getTime() + 6 * 86400000);
  const range = `${fmtDate(start)}~${fmtDate(end)}`;
  if (wk === thisWeekKey && wk === scheduleWeekKey) return '本周/排班周 ' + range;
  if (wk === thisWeekKey) return '本周 ' + range;
  if (wk === scheduleWeekKey) return '排班周 ' + range;
  return range;
}

let allHistory = [];
let historyRefreshTimer = null;
let historyResponseTag = '';
let historyRequestInFlight = false;

function buildHistoryGroupFilter() {
  const sel = document.getElementById('historyGroupFilter');
  if (!sel) return;
  const selected = sel.value;
  const options = new Map();
  (data.groups || []).forEach(group => options.set(group.name, group.name));
  (weekGroups() || []).forEach(group => options.set(group.name, group.name));
  (allHistory || []).forEach(entry => {
    const key = historyAreaKey(entry);
    if (key && key !== '总览') options.set(key, historyAreaLabel(entry));
  });
  sel.innerHTML = '<option value="">全部小组与人员来源</option>'
    + [...options].map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
  if ([...sel.options].some(option => option.value === selected)) sel.value = selected;
}

function applyHistoryOpenContext() {
  if (!historyOpenContext) return;
  const groupFilter = document.getElementById('historyGroupFilter');
  const weekFilter = document.getElementById('historyWeekFilter');
  groupFilter.value = [...groupFilter.options].some(option => option.value === historyOpenContext.group)
    ? historyOpenContext.group
    : '';
  weekFilter.value = [...weekFilter.options].some(option => option.value === historyOpenContext.week)
    ? historyOpenContext.week
    : '';
  historyOpenContext = null;
  updateHistoryCellFilterUI();
}

async function loadAllHistory(applyOpenContext = false) {
  const list = document.getElementById('historyList');
  const summary = document.getElementById('historySummary');
  if (!list) return;
  if (historyRequestInFlight) return;
  historyRequestInFlight = true;
  const prevScroll = list.scrollTop;
  if (!list.innerHTML.includes('hd-item')) list.innerHTML = '<div class="hd-empty">加载中…</div>';
  try {
    const headers = historyResponseTag ? { 'If-None-Match': historyResponseTag } : {};
    const res = await fetch(`${API_BASE}/api/history?limit=8000`, { headers });
    if (res.status === 304) {
      buildHistoryGroupFilter();
      buildWeekFilter();
      if (applyOpenContext && historyOpenContext) {
        applyHistoryOpenContext();
      }
      renderHistoryList();
      list.scrollTop = prevScroll;
      return;
    }
    if (!res.ok) throw new Error('fail');
    historyResponseTag = res.headers.get('ETag') || '';
    const r = await res.json();
    allHistory = r.history || [];
    buildHistoryGroupFilter();
    buildWeekFilter();
    if (applyOpenContext && historyOpenContext) {
      applyHistoryOpenContext();
    }
    renderHistoryList();
    list.scrollTop = prevScroll;
  } catch (e) {
    if (summary) summary.textContent = '读取失败，请检查网络后重试';
    if (!list.innerHTML.includes('hd-item')) list.innerHTML = '<div class="hd-empty">加载失败</div>';
  } finally {
    historyRequestInFlight = false;
  }
}

function buildWeekFilter() {
  const sel = document.getElementById('historyWeekFilter');
  if (!sel) return;
  const selected = sel.value;
  const thisWeekKey = fmtFull(getMonday(new Date()));
  const scheduleWeekKey = fmtFull(getMonday(new Date(Date.now() + 7 * 86400000)));
  const weeks = new Set();
  weeks.add(thisWeekKey);
  weeks.add(scheduleWeekKey);
  (allHistory || []).forEach(h => { if (h.week) weeks.add(h.week); });
  const opts = ['<option value="">全部周</option>'];
  [...weeks].sort().forEach(wk => {
    opts.push(`<option value="${wk}">${weekLabelOf(wk)}</option>`);
  });
  sel.innerHTML = opts.join('');
  if ([...sel.options].some(option => option.value === selected)) sel.value = selected;
}

function historyEntryTouchesCell(entry, context) {
  if (!entry || !context || isPersonHistory(entry)) return false;
  if ((entry.week || '') !== context.week) return false;
  if (entry.action === 'leaveSet' || entry.action === 'leaveClear') {
    const samePerson = entry.personId ? entry.personId === context.personId : entry.person === context.person;
    return samePerson && (entry.date || '') === context.date;
  }
  if (!context.overview) {
    const sameGroup = entry.groupId && context.groupId
      ? entry.groupId === context.groupId
      : historyAreaKey(entry) === context.group;
    if (!sameGroup) return false;
  }
  if (entry.action === 'move') {
    const exactSource = entry.fromPersonId === context.personId && entry.fromDate === context.date;
    const exactTarget = entry.toPersonId === context.personId && entry.toDate === context.date;
    if (exactSource || exactTarget) return true;
    const legacyLabel = `${context.person}·${context.weekday}`;
    return entry.fromLabel === legacyLabel || entry.toLabel === legacyLabel;
  }
  const samePerson = entry.personId ? entry.personId === context.personId : entry.person === context.person;
  return samePerson && (entry.date || '') === context.date;
}

function normalizeHistoryText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function historyEntryMatchesGroup(entry, location) {
  if (entry.groupId && location.groupId) return entry.groupId === location.groupId;
  return historyAreaKey(entry) === location.group;
}

function historyEntryMatchesLocation(entry, location) {
  if (!historyEntryMatchesGroup(entry, location)) return false;
  const samePerson = entry.personId && location.personId
    ? entry.personId === location.personId
    : entry.person === location.person;
  return samePerson && (entry.date || '') === location.date;
}

function moveLabelLocation(label, week) {
  const text = String(label || '');
  const splitAt = text.lastIndexOf('·');
  if (splitAt < 0) return null;
  const person = text.slice(0, splitAt);
  const weekday = text.slice(splitAt + 1);
  const dayIndex = ['周一','周二','周三','周四','周五','周六','周日'].indexOf(weekday);
  if (dayIndex < 0) return null;
  const date = new Date(week + 'T00:00:00');
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + dayIndex);
  return { person, weekday, date: fmtFull(date) };
}

function moveTargetsLocation(entry, location) {
  if (!historyEntryMatchesGroup(entry, location)) return false;
  if (entry.toPersonId && entry.toDate && location.personId) {
    return entry.toPersonId === location.personId && entry.toDate === location.date;
  }
  return entry.toLabel === `${location.person}·${location.weekday}`;
}

function moveSourceLocation(entry, currentLocation) {
  const legacy = moveLabelLocation(entry.fromLabel, entry.week);
  return {
    groupId: entry.groupId || currentLocation.groupId,
    group: entry.group || currentLocation.group,
    personId: entry.fromPersonId || '',
    person: legacy ? legacy.person : '',
    date: entry.fromDate || (legacy ? legacy.date : ''),
    weekday: legacy ? legacy.weekday : weekdayName(entry.fromDate || ''),
  };
}

function historyEntriesForCell(entries, context) {
  const source = Array.isArray(entries) ? entries : [];
  const blocks = Array.isArray(context && context.blocks) ? context.blocks : [];
  if (!blocks.length) return source.filter(entry => historyEntryTouchesCell(entry, context));
  const matched = new Set();
  source.filter(entry => historyEntryTouchesCell(entry, context)
    && (entry.action === 'leaveSet' || entry.action === 'leaveClear'))
    .forEach(entry => matched.add(entry.id || entry));
  blocks.forEach(block => {
    let note = normalizeHistoryText(block.note);
    let location = {
      groupId: block.groupId || context.groupId || '',
      group: block.group || context.group || '',
      personId: context.personId,
      person: context.person,
      date: context.date,
      weekday: context.weekday,
    };
    let before = Number.POSITIVE_INFINITY;
    for (let depth = 0; depth < 200 && note; depth += 1) {
      const candidate = source
        .filter(entry => (entry.week || '') === context.week)
        .filter(entry => {
          const time = Date.parse(entry.ts || '');
          if (!Number.isNaN(time) && time >= before) return false;
          if (entry.action === 'move') {
            return moveTargetsLocation(entry, location)
              && normalizeHistoryText(entry.content) === note;
          }
          if (!historyEntryMatchesLocation(entry, location)) return false;
          const newValue = entry.detail && entry.detail.new !== undefined
            ? normalizeHistoryText(entry.detail.new)
            : normalizeHistoryText(entry.content);
          return newValue === note;
        })
        .sort((left, right) => Date.parse(right.ts || '') - Date.parse(left.ts || ''))[0];
      if (!candidate) break;
      matched.add(candidate.id || candidate);
      const time = Date.parse(candidate.ts || '');
      before = Number.isNaN(time) ? before - 1 : time;
      if (candidate.action === 'move') {
        location = moveSourceLocation(candidate, location);
      } else if (candidate.action === 'modify') {
        note = normalizeHistoryText(candidate.detail && candidate.detail.old);
      } else if (candidate.action === 'add') {
        break;
      } else {
        break;
      }
    }
  });
  return source.filter(entry => matched.has(entry.id || entry));
}

document.addEventListener('contextmenu', event => {
  if (event.target.closest('textarea, input, select')) return;
  const cell = event.target.closest('#editTable .cell, #overviewTable .ov-cell');
  if (!cell) return;
  const person = weekPeople().find(item => item.id === cell.dataset.pid);
  const date = cell.dataset.date || '';
  if (!person || !date) return;
  event.preventDefault();
  const overview = Boolean(cell.closest('#overviewTable'));
  const blocks = overview
    ? getScheduleInfo(person.id, date).map(block => ({ groupId: block.groupId, group: block.groupName, note: block.note }))
    : getEntries(activeGroupId, person.id, date).map(entry => ({ groupId: activeGroupId, group: resolveGroupName(activeGroupId), note: entry.note }));
  openCellHistoryDrawer({
    week: wsKey(),
    groupId: overview ? '' : activeGroupId,
    group: overview ? '' : resolveGroupName(activeGroupId),
    overview,
    personId: person.id,
    person: person.name,
    date,
    weekday: weekdayName(date),
    blocks,
  });
});

function renderHistoryList() {
  const list = document.getElementById('historyList');
  const summary = document.getElementById('historySummary');
  if (!list) return;
  const g = document.getElementById('historyGroupFilter').value;
  const wk = document.getElementById('historyWeekFilter').value;
  const q = document.getElementById('historySearch').value.trim().toLowerCase();
  let h = allHistory || [];
  if (historyCellContext) h = historyEntriesForCell(h, historyCellContext);
  if (g) h = h.filter(x => historyAreaKey(x) === g);
  if (wk) h = h.filter(x => (x.week || '') === wk);
  if (q) h = h.filter(x => (
    (x.user || '') + (x.person || '') + (x.content || '') + (x.week || '')
    + historyAreaLabel(x) + personCategoryLabel(x)
  ).toLowerCase().includes(q));
  h = h.slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
  if (summary) {
    const groupSelect = document.getElementById('historyGroupFilter');
    const groupLabel = g && groupSelect.selectedIndex >= 0
      ? groupSelect.options[groupSelect.selectedIndex].textContent
      : '全部小组与人员来源';
    const weekSelect = document.getElementById('historyWeekFilter');
    const weekLabel = wk && weekSelect.selectedIndex >= 0
      ? weekSelect.options[weekSelect.selectedIndex].textContent
      : '全部周';
    summary.textContent = historyCellContext
      ? `该单元格内容自新增起共 ${h.length} 条修改记录（全部 ${allHistory.length} 条）`
      : `${weekLabel} · ${groupLabel} · 显示 ${h.length} 条（全部 ${allHistory.length} 条）`;
  }
  if (!h.length) {
    list.innerHTML = historyCellContext
      ? '<div class="hd-empty">该单元格暂无修改记录</div>'
      : '<div class="hd-empty">没有符合筛选条件的修改记录</div>';
    return;
  }

  let lastDate = '';
  const html = [];
  h.forEach(e => {
    const t = new Date(e.ts);
    const dateLabel = isNaN(t)
      ? '时间未知'
      : `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日 星期${'日一二三四五六'[t.getDay()]}`;
    const time = isNaN(t)
      ? String(e.ts || '')
      : `${t.getFullYear()}/${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')} `
        + t.toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
    if (dateLabel !== lastDate) {
      html.push(`<div class="hd-date-separator"><span>${esc(dateLabel)}</span></div>`);
      lastDate = dateLabel;
    }

    const label = ACTION_LABEL[e.action] || e.action || '操作';
    const cls = ACTION_LABEL[e.action] ? e.action : 'modify';
    const personAction = isPersonHistory(e);
    const personScope = personHistoryScope(e);
    const areaLabel = historyAreaLabel(e);
    const categoryLabel = personCategoryLabel(e);
    const placement = [
      e.person || '',
      e.weekday || '',
    ].filter(Boolean).map(value => esc(value)).join(' · ') || '—';
    let contentHtml = '';
    let positionHtml = '';
    if (e.action === 'move') {
      contentHtml = `<div class="hd-content-box">${esc(e.content || '未填写内容')}</div>`;
      positionHtml = `<div class="hd-route" aria-label="从原位置移动到新位置">
        <div class="hd-route-point old" aria-label="原位置"><strong>${esc(e.fromLabel || '—')}</strong></div>
        <span class="hd-route-arrow" aria-hidden="true">→</span>
        <div class="hd-route-point new" aria-label="新位置"><strong>${esc(e.toLabel || '—')}</strong></div>
      </div>`;
    } else if (e.action === 'modify') {
      const old = (e.detail && e.detail.old) || '';
      const nw = (e.detail && e.detail.new) || '';
      contentHtml = `<div class="hd-route">
        <div class="hd-route-point old"><span>修改前</span><strong>${esc(old || '（空）')}</strong></div>
        <span class="hd-route-arrow" aria-hidden="true">→</span>
        <div class="hd-route-point new"><span>修改后</span><strong>${esc(nw || '（空）')}</strong></div>
      </div>`;
      positionHtml = `<div class="hd-place-box">${placement}</div>`;
    } else if (e.action === 'delete') {
      contentHtml = `<div class="hd-content-box old">${esc(e.content || '（空内容）')}</div>`;
      positionHtml = `<div class="hd-place-box">${placement}</div>`;
    } else {
      contentHtml = `<div class="hd-content-box">${esc(e.content || '未填写补充内容')}</div>`;
      positionHtml = `<div class="hd-place-box">${placement}</div>`;
    }

    let personDetailHtml = '';
    if (personAction) {
      if (e.action === 'renamePerson') {
        const oldName = (e.detail && e.detail.old) || String(e.content || '').split('→')[0].trim();
        const newName = (e.detail && e.detail.new) || String(e.content || '').split('→').slice(1).join('→').trim();
        personDetailHtml = `<div class="hd-detail-row hd-person-row">
          <span class="hd-detail-label">人员变更</span>
          <div class="hd-value"><div class="hd-route">
            <div class="hd-route-point old"><strong>${esc(oldName || '—')}</strong></div>
            <span class="hd-route-arrow" aria-hidden="true">→</span>
            <div class="hd-route-point new"><strong>${esc(newName || '—')}</strong></div>
          </div></div>
        </div>`;
      } else {
        personDetailHtml = `<div class="hd-detail-row hd-person-row">
          <span class="hd-detail-label">人员</span>
          <div class="hd-value"><div class="hd-content-box">${esc(e.content || e.person || '—')}</div></div>
        </div>`;
      }
    }

    const contextHtml = personAction
      ? `${personScope === 'week' ? `<strong>${esc(weekLabelOf(e.week))}</strong><i aria-hidden="true">·</i>` : ''}
         <strong class="hd-source-label">${esc(areaLabel)}</strong>
         ${categoryLabel ? `<i aria-hidden="true">·</i><span>${esc(categoryLabel)}</span>` : ''}`
      : `<strong>${esc(weekLabelOf(e.week))}</strong>
         <i aria-hidden="true">·</i>
         <strong>${esc(e.group || '未分组')}</strong>`;

    html.push(`<article class="hd-item${personAction ? ' hd-item-person' : ''}">
      <div class="hd-item-head">
        <span class="hd-user">${esc(e.user || '匿名')}</span>
        <div class="hd-context">
          ${contextHtml}
        </div>
        <div class="hd-action-meta">
          <span class="hd-tag ${cls}">${esc(label)}</span>
          <time class="hd-time">${esc(time)}</time>
        </div>
      </div>
      ${personAction ? personDetailHtml : `<div class="hd-detail-row">
          <span class="hd-detail-label">内容</span>
          <div class="hd-value">${contentHtml}</div>
        </div>
        <div class="hd-detail-row">
          <span class="hd-detail-label">位置</span>
          <div class="hd-value">${positionHtml}</div>
        </div>`}
    </article>`);
  });
  list.innerHTML = html.join('');
}
