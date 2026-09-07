// ========================= 工具 =========================
function getMonday(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  dt.setDate(dt.getDate() - day + (day===0?-6:1));
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}
function fmtDate(d) { return `${d.getMonth()+1}/${d.getDate()}`; }
function fmtFull(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function fmtExportDate(d) { return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`; }
function weekDates(monday) {
  const ds = [];
  for (let i=0;i<7;i++) { const d=new Date(monday); d.setDate(monday.getDate()+i); ds.push(d); }
  return ds;
}
function wsKey() { return fmtFull(currentWeek); }
function skey(personId, dateStr) { return `${personId}_${dateStr}`; }
function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function calendarDayInfo(date) {
  return window.WorkCalendar
    ? window.WorkCalendar.getDayInfo(date)
    : { kind: (date.getDay() === 0 || date.getDay() === 6) ? 'rest' : 'work', mark: (date.getDay() === 0 || date.getDay() === 6) ? '休' : '班', name: '', adjusted: false };
}
function calendarHeaderHTML(date, dayIndex) {
  const info = calendarDayInfo(date);
  const title = info.name ? ` title="${esc(info.name)}"` : '';
  const adjusted = info.adjusted ? ' calendar-day-adjusted' : '';
  return `<th class="calendar-day calendar-day-${info.kind}${adjusted}"${title}>${fmtDate(date)}<br><small>${DAY_NAMES[dayIndex]} <span class="calendar-mark">${info.mark}</span></small></th>`;
}
function scheduleWeekKey() { return fmtFull(getMonday(new Date(Date.now() + 7*86400000))); }
function isFutureScheduleWeek(weekKey = wsKey()) { return String(weekKey || '') > scheduleWeekKey(); }
function canEditScheduleWeek(weekKey = wsKey()) {
  if (!isFutureScheduleWeek(weekKey)) return true;
  return typeof isPermissionAdmin === 'function' && isPermissionAdmin();
}
function requireScheduleWeekEdit(weekKey = wsKey(), notify = true) {
  const allowed = canEditScheduleWeek(weekKey);
  if (!allowed && notify) toast('还未进入排班时间');
  return allowed;
}
function autoResizeTextarea(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

// 默认人员（常用模板），管理弹窗里编辑，新周首次打开自动拷贝
function allPeople() {
  return [
    ...data.internalPeople.map(p => ({...p, _cat: 'internal'})),
    ...data.externalPeople.map(p => ({...p, _cat: 'external'})),
  ];
}

// 当前周的人员列表 —— 每周独立
// 锁规则：有排班数据 或 被增删改过 → 锁定，不再从模板同步
// 如果人员列表与模板完全一致且无排班数据 → 不锁定，每次切过来重新从模板拿最新
function rawWeekPeople() {
  const ws = wsKey();
  if (!data.weekPeople) data.weekPeople = {};
  if (!data.weekPeopleLocked) data.weekPeopleLocked = {};

  if (data.weekPeople[ws]) {
    // 已锁定 → 保持不变
    if (data.weekPeopleLocked[ws]) return data.weekPeople[ws];
    // 有排班数据 → 自动锁定
    if (hasWeekData(ws)) {
      data.weekPeopleLocked[ws] = true;
      return data.weekPeople[ws];
    }
    // 未锁定且无数据 → 重新从模板同步
    data.weekPeople[ws] = buildPeopleFromTemplate();
    return data.weekPeople[ws];
  }

  // 首次访问
  data.weekPeople[ws] = buildPeopleFromTemplate();
  return data.weekPeople[ws];
}

// 排班表始终先展示全部内部人员，再展示外协人员；同一分类内保留原有顺序。
// 返回展示副本，不重排数据库中的周人员数组，避免仅浏览页面就产生数据写入。
function orderWeekPeopleForDisplay(list) {
  return (list || [])
    .map((person, index) => ({ person, index }))
    .sort((left, right) => {
      const leftRank = left.person && left.person._cat === 'external' ? 1 : 0;
      const rightRank = right.person && right.person._cat === 'external' ? 1 : 0;
      return leftRank - rightRank || left.index - right.index;
    })
    .map(item => item.person);
}

function weekPeople() {
  return orderWeekPeopleForDisplay(rawWeekPeople());
}

function buildPeopleFromTemplate() {
  return [
    ...data.internalPeople.map(p => ({ id: p.id, name: p.name, _cat: 'internal' })),
    ...data.externalPeople.map(p => ({ id: p.id, name: p.name, _cat: 'external' })),
  ];
}

function hasWeekData(ws) {
  if (!data.schedules[ws]) return false;
  return Object.values(data.schedules[ws]).some(g => Object.keys(g).length > 0);
}

// 标记当前周已锁定（增删改人员时调用）
function lockWeekPeople() {
  if (!data.weekPeopleLocked) data.weekPeopleLocked = {};
  data.weekPeopleLocked[wsKey()] = true;
  saveData();
}

// ========================= 每周期小组（模板拷贝） =========================
function weekGroups() {
  const ws = wsKey();
  if (!data.weekGroups) data.weekGroups = {};
  if (!data.weekGroupLocked) data.weekGroupLocked = {};
  const scheduleWeek = fmtFull(getMonday(new Date(Date.now() + 7*86400000)));

  if (data.weekGroups[ws]) {
    // 历史周 → 永久锁定，不跟模板
    if (ws < scheduleWeek) {
      data.weekGroupLocked[ws] = true;
      return data.weekGroups[ws];
    }
    // 排班周/未来周：已锁定或有数据 → 保持
    if (data.weekGroupLocked[ws]) return data.weekGroups[ws];
    if (hasWeekData(ws)) { data.weekGroupLocked[ws] = true; return data.weekGroups[ws]; }
    // 未锁定 → 从模板同步
    data.weekGroups[ws] = data.groups.map(g => ({ ...g }));
    return data.weekGroups[ws];
  }
  // 首次访问
  data.weekGroups[ws] = data.groups.map(g => ({ ...g }));
  // 历史周首次即锁定
  if (ws < scheduleWeek) data.weekGroupLocked[ws] = true;
  return data.weekGroups[ws];
}

function lockWeekGroups(persist = true) {
  if (!data.weekGroupLocked) data.weekGroupLocked = {};
  data.weekGroupLocked[wsKey()] = true;
  if (persist) saveData();
}

// 在所有列表（默认+各周）中查找人员信息
function findPersonInAll(id) {
  // 默认人员
  let p = data.internalPeople.find(x => x.id === id);
  if (p) return { name: p.name, cat: 'internal' };
  p = data.externalPeople.find(x => x.id === id);
  if (p) return { name: p.name, cat: 'external' };
  // 各周数据
  if (data.weekPeople) {
    for (const ws of Object.keys(data.weekPeople)) {
      p = data.weekPeople[ws].find(x => x.id === id);
      if (p) return { name: p.name, cat: p._cat };
    }
  }
  return null;
}

function findPersonList(id) {
  // 先在当前周找
  const wp = rawWeekPeople();
  const wpFound = wp.find(p => p.id === id);
  if (wpFound) return { list: wp, cat: wpFound._cat, weekPeople: true };

  // 再在默认人员中找
  if (data.internalPeople.find(p => p.id === id)) return { list: data.internalPeople, cat: 'internal' };
  if (data.externalPeople.find(p => p.id === id)) return { list: data.externalPeople, cat: 'external' };
  return null;
}

// ========================= 数组化数据模型 =========================
// 单元格数据统一为 entries 数组：data.schedules[ws][groupId][key] = [{note}, ...]
// 兼容旧格式（单个 {note} 对象或字符串），读取时自动归一化。
function normEntries(v) {
  const cleanNote = n => typeof n === 'string' ? n.replace(/\u2424/g, '\n').replace(/\r/g, '').replace(/^\n+|\n+$/g, '') : n;
  if (!v) return [];
  if (Array.isArray(v)) return v.map(e => ({ note: cleanNote((e && (typeof e === 'string' ? e : e.note)) || '') })).filter(e => e.note && e.note.trim());
  if (typeof v === 'string') return v.trim() ? [{ note: cleanNote(v) }] : [];
  if (v && typeof v === 'object' && v.note !== undefined) return v.note.trim() ? [{ note: cleanNote(v.note) }] : [];
  return [];
}

function getEntries(groupId, personId, dateStr) {
  const ws = wsKey();
  if (!data.schedules[ws] || !data.schedules[ws][groupId]) return [];
  return normEntries(data.schedules[ws][groupId][skey(personId, dateStr)]);
}

function setEntries(groupId, personId, dateStr, arr) {
  const ws = wsKey();
  if (!data.schedules[ws]) data.schedules[ws] = {};
  if (!data.schedules[ws][groupId]) data.schedules[ws][groupId] = {};
  const key = skey(personId, dateStr);
  const clean = (arr || [])
    .filter(e => { const n = e && (e.note !== undefined ? e.note : e); return n && typeof n.trim === 'function' && n.trim(); })
    .map(e => ({ note: (e.note !== undefined ? e.note : e).replace(/\u2424/g, '\n').replace(/\r/g, '').replace(/^\n+|\n+$/g, '') }));
  if (clean.length) data.schedules[ws][groupId][key] = clean;
  else delete data.schedules[ws][groupId][key];
}

function getCellEntries(personId, dateStr) {
  return getEntries(activeGroupId, personId, dateStr);
}

function setCellEntries(personId, dateStr, arr) {
  setEntries(activeGroupId, personId, dateStr, arr);
}

// 兼容旧调用：getCell 返回首个 entry（无则 null），.note 仍可访问
function getCell(personId, dateStr) {
  const arr = getCellEntries(personId, dateStr);
  return arr.length ? arr[0] : null;
}

function setCellValue(personId, dateStr, val) {
  if (Array.isArray(val)) { setCellEntries(personId, dateStr, val); return; }
  setCellEntries(personId, dateStr, val ? [{ note: val }] : []);
}

// ========================= Toast =========================
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; setTimeout(()=>t.remove(),300); }, 1500);
}

// ========================= 撤销/重做 =========================
let _opSeq = 0;
function pushUndo(changes, opMeta) {
  if (changes.length === 0) return;
  const opId = 'op_' + Date.now() + '_' + (++_opSeq) + '_' + Math.random().toString(36).slice(2, 6);
  logChanges(changes, opId, opMeta);
  undoStack.push({ changes, groupId: activeGroupId, week: wsKey(), opId });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
  updateUndoHint();
}

async function undo() {
  if (editing) commitEdit();
  if (undoStack.length === 0) { toast('没有可撤销的操作'); return; }
  if (!requireScheduleWeekEdit(undoStack[undoStack.length - 1].week)) return;
  const action = undoStack.pop();
  redoStack.push(action);

  // 切到对应组和周
  const needRerender = (action.groupId !== activeGroupId || action.week !== wsKey());
  if (action.week !== wsKey()) {
    currentWeek = new Date(action.week + 'T00:00:00');
    updateWeekUI();
  }
  if (action.groupId !== activeGroupId) {
    activeGroupId = action.groupId;
  }

  action.changes.forEach(ch => {
    if (ch.groupId) {
      setGroupCell(ch.groupId, ch.personId, ch.dateStr, ch.oldVal);
    } else {
      setCellValue(ch.personId, ch.dateStr, ch.oldVal);
    }
  });
  saveData();
  clearSelection();
  updateUndoHint();
  if (needRerender) renderAll(); else if (activeGroupId === '__overview__') renderOverview(); else renderEditTable();

  // 净态对账：撤销即移除对应的历史记录，使历史永远等于屏幕最终态
  if (action.opId) {
    try {
      const r = await fetch(`${API_BASE}/api/history/remove`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opIds: [action.opId] })
      });
      const j = await r.json();
      action.removedEntries = (j && j.removed) || [];
    } catch (e) { action.removedEntries = []; }
  }
  toast('已撤销');
}

async function redo() {
  if (editing) commitEdit();
  if (redoStack.length === 0) { toast('没有可重做的操作'); return; }
  if (!requireScheduleWeekEdit(redoStack[redoStack.length - 1].week)) return;
  const action = redoStack.pop();
  undoStack.push(action);

  const needRerender = (action.groupId !== activeGroupId || action.week !== wsKey());
  if (action.week !== wsKey()) {
    currentWeek = new Date(action.week + 'T00:00:00');
    updateWeekUI();
  }
  if (action.groupId !== activeGroupId) {
    activeGroupId = action.groupId;
  }

  action.changes.forEach(ch => {
    if (ch.groupId) {
      setGroupCell(ch.groupId, ch.personId, ch.dateStr, ch.newVal);
    } else {
      setCellValue(ch.personId, ch.dateStr, ch.newVal);
    }
  });
  saveData();
  clearSelection();
  updateUndoHint();
  if (needRerender) renderAll(); else if (activeGroupId === '__overview__') renderOverview(); else renderEditTable();

  // 净态对账：重做即把被撤销的记录加回（保留原 id/opId/ts）
  if (action.removedEntries && action.removedEntries.length) {
    appendHistory(action.removedEntries);
  }
  toast('已重做');
}

function updateUndoHint() {
  const el = document.getElementById('undoHint');
  el.textContent = undoStack.length > 0 ? `可撤销 ${undoStack.length} 步` : '';
}

// ========================= 选区 =========================
function clearSelection() {
  sel = null; selAnchor = null; activeCell = null; selExtra = new Set();
  updateFillHandle();
  if (typeof presenceClearCell === 'function') presenceClearCell();
}

function getRadarFields() {
  if (!Array.isArray(data.personRadarFields)) return [];
  return data.personRadarFields
    .filter(field => field && field.id && String(field.name || '').trim())
    .slice(0, 8);
}

function getPersonRadarScores(personId) {
  const scores = data.personRadarScores && data.personRadarScores[personId];
  return scores && typeof scores === 'object' && !Array.isArray(scores) ? scores : {};
}

function normalizeRadarScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(10, Math.round(number)));
}

// 全局休假独立于小组排班：一个“人员 × 日期”只存一份，各小组和总览共同读取。
function getTimeOff(personId, dateStr, weekKey = wsKey()) {
  const week = data.timeOff && data.timeOff[weekKey];
  return week && week[skey(personId, dateStr)] ? week[skey(personId, dateStr)] : null;
}

function timeOffChipHTML(timeOff, compact = false) {
  if (!timeOff) return '';
  const note = String(timeOff.note || '').trim();
  const label = note ? `休假 · ${esc(note)}` : '休假';
  return `<div class="timeoff-chip${compact ? ' compact' : ''}" title="全局休假：所有小组都能看到">${label}</div>`;
}

let timeOffDraft = null;

function requireTimeOffPermission() {
  const allowed = typeof isPermissionAdmin === 'function' && isPermissionAdmin();
  if (!allowed) toast('只有张雅镜、简慧仪、林俊凯可以设置全局休假');
  return allowed;
}

function openTimeOffModal(personId, dateStr) {
  if (!requireTimeOffPermission()) return;
  const person = weekPeople().find(item => item.id === personId);
  if (!person) return;
  const existing = getTimeOff(personId, dateStr);
  const blocks = getScheduleInfo(personId, dateStr);
  const date = new Date(`${dateStr}T00:00:00`);
  const dayInfo = calendarDayInfo(date);
  timeOffDraft = { personId, dateStr };
  document.getElementById('timeOffModalTitle').textContent = existing ? '编辑全局休假' : '设置全局休假';
  document.getElementById('timeOffModalMeta').textContent = `${person.name} · ${dateStr} ${weekdayName(dateStr)}`;
  document.getElementById('timeOffCalendarSummary').innerHTML = `<span class="calendar-mark ${dayInfo.kind}">${dayInfo.mark}</span><strong>${dayInfo.kind === 'rest' ? '日历休息日' : '日历工作日'}</strong>${dayInfo.name ? `<small>${esc(dayInfo.name)}</small>` : ''}`;
  document.getElementById('timeOffNote').value = existing ? String(existing.note || '') : '';
  const conflict = document.getElementById('timeOffConflict');
  conflict.style.display = blocks.length ? '' : 'none';
  conflict.textContent = blocks.length ? `这一天已有 ${blocks.length} 项排班。系统不会自动删除，设置休假后会保留并标记冲突，便于人工调整。` : '';
  document.getElementById('timeOffRemoveBtn').style.display = existing ? '' : 'none';
  document.getElementById('timeOffModal').style.display = 'flex';
  setTimeout(() => document.getElementById('timeOffNote').focus(), 0);
}

function closeTimeOffModal() {
  const modal = document.getElementById('timeOffModal');
  if (modal) modal.style.display = 'none';
  timeOffDraft = null;
}

function writeTimeOffHistory(action, personId, dateStr, note) {
  appendHistory([{
    user: userName(), ts: new Date().toISOString(), week: wsKey(),
    group: '全局休假', groupId: '__timeoff__', person: resolvePersonName(personId), personId,
    date: dateStr, weekday: weekdayName(dateStr), action,
    content: note || '休假', detail: { new: action === 'leaveSet' ? (note || '休假') : '', old: action === 'leaveClear' ? (note || '休假') : '' },
  }]);
}

function saveTimeOff() {
  if (!timeOffDraft || !requireTimeOffPermission()) return;
  const { personId, dateStr } = timeOffDraft;
  const note = document.getElementById('timeOffNote').value.trim().slice(0, 100);
  if (!data.timeOff || typeof data.timeOff !== 'object') data.timeOff = {};
  if (!data.timeOff[wsKey()] || typeof data.timeOff[wsKey()] !== 'object') data.timeOff[wsKey()] = {};
  data.timeOff[wsKey()][skey(personId, dateStr)] = { note, updatedBy: userName(), updatedAt: new Date().toISOString() };
  writeTimeOffHistory('leaveSet', personId, dateStr, note);
  saveData();
  closeTimeOffModal();
  renderAll();
  toast('休假已同步到总览和所有小组');
}

function removeTimeOff() {
  if (!timeOffDraft || !requireTimeOffPermission()) return;
  const { personId, dateStr } = timeOffDraft;
  const existing = getTimeOff(personId, dateStr);
  if (!existing) return closeTimeOffModal();
  delete data.timeOff[wsKey()][skey(personId, dateStr)];
  if (!Object.keys(data.timeOff[wsKey()]).length) delete data.timeOff[wsKey()];
  writeTimeOffHistory('leaveClear', personId, dateStr, String(existing.note || ''));
  saveData();
  closeTimeOffModal();
  renderAll();
  toast('该天休假已取消');
}

function splitRadarLabel(value, maxChars = 6) {
  const remaining = Array.from(String(value || '').trim());
  if (remaining.length === 0) return [''];
  const lines = [];
  while (remaining.length > maxChars) {
    let cut = maxChars;
    for (let index = maxChars; index >= 3; index--) {
      if (/[、，,\/｜·＆&\s]/.test(remaining[index - 1])) { cut = index; break; }
    }
    lines.push(remaining.splice(0, cut).join('').trim());
  }
  if (remaining.length) lines.push(remaining.join('').trim());
  return lines.filter(Boolean);
}

function resolvePersonRadar(personId) {
  const fields = getRadarFields();
  const scores = getPersonRadarScores(personId);
  if (fields.length < 3 || !fields.some(field => Object.prototype.hasOwnProperty.call(scores, field.id))) return null;
  return { fields, scores };
}

function buildPersonRadarSVG(fields, scores, options = {}) {
  const width = Number(options.width) || 340;
  const height = Number(options.height) || 270;
  const safeFields = (fields || []).slice(0, 8);
  if (safeFields.length < 3) return '<div class="person-radar-empty">至少需要 3 个字段</div>';
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width * 0.255, height * 0.29);
  const labelRadius = radius + 27;
  const point = (index, distance) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / safeFields.length;
    return [cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance];
  };
  const pointsText = points => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const grid = [2, 4, 6, 8, 10].map(level => {
    const points = safeFields.map((_, index) => point(index, radius * level / 10));
    return `<polygon class="radar-grid" points="${pointsText(points)}"></polygon>`;
  }).join('');
  const axes = safeFields.map((_, index) => {
    const [x, y] = point(index, radius);
    return `<line class="radar-axis" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"></line>`;
  }).join('');
  const values = safeFields.map((field, index) => point(index, radius * normalizeRadarScore(scores[field.id]) / 10));
  const markers = values.map(([x, y]) => `<circle class="radar-marker" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2"></circle>`).join('');
  const labels = safeFields.map((field, index) => {
    const [x, y] = point(index, labelRadius);
    const anchor = x > cx + 5 ? 'start' : x < cx - 5 ? 'end' : 'middle';
    const dy = y > cy + 5 ? 7 : y < cy - 5 ? -2 : 4;
    const lines = splitRadarLabel(field.name);
    const lineHeight = 13;
    const firstY = y + dy - (lines.length - 1) * lineHeight / 2;
    const tspans = lines.map((line, lineIndex) => `<tspan x="${x.toFixed(1)}" y="${(firstY + lineIndex * lineHeight).toFixed(1)}">${esc(line)}</tspan>`).join('');
    return `<text class="radar-label" x="${x.toFixed(1)}" text-anchor="${anchor}">${tspans}</text>`;
  }).join('');
  return `<svg class="person-radar-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">
    ${grid}${axes}<polygon class="radar-value" points="${pointsText(values)}"></polygon>${markers}${labels}
  </svg>`;
}

function buildRadarScoreLegend(fields, scores) {
  return fields.map(field => `<span><b>${esc(field.name)}</b><em>${normalizeRadarScore(scores[field.id])}</em></span>`).join('');
}

function personNameHTML(person) {
  const radar = resolvePersonRadar(person.id);
  const radarClass = radar ? ' has-radar' : '';
  const radarAttrs = radar ? ' tabindex="0" aria-describedby="personRadarTooltip" title="悬停预览，单击固定雷达图"' : '';
  return `<span class="person-name${radarClass}"${radarAttrs} data-person-id="${esc(person.id)}">${esc(person.name)}</span>`;
}

function initPersonRadarTooltip() {
  if (document.getElementById('personRadarTooltip')) return;
  const tooltip = document.createElement('div');
  tooltip.id = 'personRadarTooltip';
  tooltip.className = 'person-radar-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.setAttribute('aria-hidden', 'true');
  tooltip.innerHTML = '<strong class="person-radar-tooltip-name"></strong><div class="person-radar-tooltip-chart"></div><div class="person-radar-tooltip-legend"></div><small class="person-radar-tooltip-hint">任务雷达 · 满分 10 分</small>';
  document.body.appendChild(tooltip);

  let activeTarget = null;
  let pinnedTarget = null;
  const hide = () => {
    activeTarget = null;
    tooltip.classList.remove('visible');
    tooltip.classList.remove('pinned');
    tooltip.setAttribute('aria-hidden', 'true');
  };
  const show = (target, pinned = false) => {
    const radar = resolvePersonRadar(target.dataset.personId);
    if (!radar) { hide(); return; }
    activeTarget = target;
    tooltip.querySelector('.person-radar-tooltip-name').textContent = target.textContent.trim();
    tooltip.querySelector('.person-radar-tooltip-chart').innerHTML = buildPersonRadarSVG(radar.fields, radar.scores, { width: 520, height: 350 });
    tooltip.querySelector('.person-radar-tooltip-legend').innerHTML = buildRadarScoreLegend(radar.fields, radar.scores);
    tooltip.querySelector('.person-radar-tooltip-hint').textContent = pinned
      ? '已固定 · 点击空白处关闭'
      : '任务雷达 · 满分 10 分 · 单击姓名可固定';
    tooltip.classList.add('visible');
    tooltip.classList.toggle('pinned', pinned);
    tooltip.setAttribute('aria-hidden', 'false');
    const anchor = target.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    let left = anchor.left + anchor.width / 2 - box.width / 2;
    let top = anchor.bottom + 10;
    left = Math.max(10, Math.min(left, window.innerWidth - box.width - 10));
    if (top + box.height > window.innerHeight - 10) top = anchor.top - box.height - 10;
    tooltip.style.left = `${Math.max(10, left)}px`;
    tooltip.style.top = `${Math.max(10, top)}px`;
  };

  document.addEventListener('mouseover', event => {
    if (pinnedTarget) return;
    const target = event.target.closest && event.target.closest('.person-name[data-person-id]');
    if (target && target !== activeTarget) show(target);
  });
  document.addEventListener('mouseout', event => {
    if (pinnedTarget) return;
    const target = event.target.closest && event.target.closest('.person-name[data-person-id]');
    if (target && !target.contains(event.relatedTarget)) hide();
  });
  document.addEventListener('focusin', event => {
    if (pinnedTarget) return;
    const target = event.target.closest && event.target.closest('.person-name[data-person-id]');
    if (target) show(target);
  });
  document.addEventListener('focusout', event => {
    if (!pinnedTarget && event.target.closest && event.target.closest('.person-name[data-person-id]')) hide();
  });
  document.addEventListener('click', event => {
    const target = event.target.closest && event.target.closest('.person-name[data-person-id]');
    if (target && resolvePersonRadar(target.dataset.personId)) {
      pinnedTarget = target;
      show(target, true);
      return;
    }
    if (pinnedTarget && !tooltip.contains(event.target)) {
      pinnedTarget = null;
      hide();
    }
  }, true);
  document.addEventListener('keydown', event => {
    const target = event.target.closest && event.target.closest('.person-name[data-person-id]');
    if (target && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      pinnedTarget = target;
      show(target, true);
    } else if (event.key === 'Escape' && pinnedTarget) {
      pinnedTarget = null;
      hide();
    }
  });
  window.addEventListener('scroll', () => { if (!pinnedTarget) hide(); }, true);
  window.addEventListener('resize', () => {
    if (pinnedTarget && pinnedTarget.isConnected) show(pinnedTarget, true);
    else { pinnedTarget = null; hide(); }
  });
}

function syncPresenceActiveCell() {
  if (!activeCell || activeGroupId === '__overview__') return;
  const people = weekPeople();
  const dates = weekDates(currentWeek);
  const person = people[activeCell.r];
  const date = dates[activeCell.c];
  if (!person || !date) return;
  syncPresenceCell(person.id, fmtFull(date));
}

function syncPresenceCell(personId, dateStr, status = 'selected') {
  const handler = status === 'dragging' ? window.presenceStartDragging : window.presenceSelectCell;
  if (typeof handler !== 'function' || activeGroupId === '__overview__' || !personId || !dateStr) return;
  handler({ mode: 'group', personId, dateStr, groupId: activeGroupId, taskIndex: -1 });
}

function selectCell(r, c) {
  sel = { r1: r, c1: c, r2: r, c2: c };
  selAnchor = { r, c };
  activeCell = { r, c };
  syncPresenceActiveCell();
}

function selectRange(r, c) {
  if (!selAnchor) { selAnchor = { r, c }; }
  sel = {
    r1: Math.min(selAnchor.r, r), c1: Math.min(selAnchor.c, c),
    r2: Math.max(selAnchor.r, r), c2: Math.max(selAnchor.c, c),
  };
}

function isSelected(r, c) {
  if (selExtra.has(`${r},${c}`)) return true;
  if (!sel) return false;
  return r >= sel.r1 && r <= sel.r2 && c >= sel.c1 && c <= sel.c2;
}

function getSelectedCells() {
  const people = weekPeople();
  const cells = [];
  const added = new Set();

  // 主选区
  if (sel) {
    for (let r = sel.r1; r <= sel.r2; r++) {
      for (let c = sel.c1; c <= sel.c2; c++) {
        if (r < people.length && c < 7) {
          cells.push({ r, c, person: people[r], dateStr: fmtFull(weekDates(currentWeek)[c]) });
          added.add(`${r},${c}`);
        }
      }
    }
  }
  // Ctrl+点击追加的格子
  selExtra.forEach(key => {
    if (!added.has(key)) {
      const [r, c] = key.split(',').map(Number);
      if (r < people.length && c < 7) {
        cells.push({ r, c, person: people[r], dateStr: fmtFull(weekDates(currentWeek)[c]) });
      }
    }
  });
  return cells;
}

// ========================= 总览表选区 =========================
function highlightOverviewSelection() {
  const table = document.getElementById('overviewTable');
  if (!table) return;
  table.querySelectorAll('.cell.selected').forEach(el => el.classList.remove('selected'));
  if (!sel) return;
  for (let r = sel.r1; r <= sel.r2; r++) {
    for (let c = sel.c1; c <= sel.c2; c++) {
      const el = table.querySelector(`[data-r="${r}"][data-c="${c}"]`);
      if (el) el.classList.add('selected');
    }
  }
  selExtra.forEach(key => {
    const [r, c] = key.split(',').map(Number);
    const el = table.querySelector(`[data-r="${r}"][data-c="${c}"]`);
    if (el) el.classList.add('selected');
  });
}

function getOverviewSelectedCells() {
  const people = weekPeople();
  const dates = weekDates(currentWeek);
  const cells = [];
  const added = new Set();
  const table = document.getElementById('overviewTable');
  if (!table) return cells;
  if (sel) {
    for (let r = sel.r1; r <= sel.r2; r++) {
      for (let c = sel.c1; c <= sel.c2; c++) {
        if (r < people.length && c < 7) {
          const el = table.querySelector(`[data-r="${r}"][data-c="${c}"]`);
          const gid = el ? el.dataset.gid : '';
          cells.push({ r, c, person: people[r], dateStr: fmtFull(dates[c]), gid });
          added.add(`${r},${c}`);
        }
      }
    }
  }
  selExtra.forEach(key => {
    if (!added.has(key)) {
      const [r, c] = key.split(',').map(Number);
      if (r < people.length && c < 7) {
        const el = table.querySelector(`[data-r="${r}"][data-c="${c}"]`);
        const gid = el ? el.dataset.gid : '';
        cells.push({ r, c, person: people[r], dateStr: fmtFull(dates[c]), gid });
      }
    }
  });
  return cells;
}

// ========================= 剪贴板 =========================
// 统一剪贴板格式：系统剪贴板用 TSV（\t 列、\n 行），单元格内换行用 \u2424 占位；
// 内部 clipData = { rows, cols, data, blockData, mask }，data 内换行用真实 \n；
// mask 保留 Ctrl+点击形成的非连续选区，使跨表粘贴不会把空隙当成待覆盖单元格。
// 总览表与小组表共用该格式，因此复制粘贴无需进入编辑态即可选区操作，且跨表一致。
function parseGridText(text) {
  text = ScheduleGridClipboard.normalizeClipboardText(text);
  // 不含制表符时视为单个单元格，保留内部换行，避免多行文本被拆成多格
  if (!text.includes('\t')) {
    return { rows: 1, cols: 1, data: [[(text || '').trim()]] };
  }
  const lines = text.split('\n');
  const data = lines.map(l => l.split('\t').map(c => c.replace(/\u2424/g, '\n').trim()));
  const rows = data.length, cols = Math.max(1, ...data.map(r => r.length));
  data.forEach(r => { while (r.length < cols) r.push(''); });
  return { rows, cols, data };
}
function writeClipboardGrid(clip) {
  try {
    const text = ScheduleGridClipboard.serializeClipboardText(clip);
    navigator.clipboard.writeText(text);
  } catch (e) {}
}
// 把若干 note 合并成单元格字符串：trim、过滤空字符串，避免多余空行
function joinNotes(notes) {
  return notes.map(n => String(n || '').trim()).filter(n => n).join('\n');
}
async function readClipboardGrid() {
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim() !== '') {
      // 如果系统剪贴板内容与当前内部 clipData 的拼接结果一致，优先使用内部 blockData 以保留独立块结构
      if (clipData && clipData.data && clipData.data.length) {
        if (ScheduleGridClipboard.clipboardTextMatches(clipData, text)) {
          return { rows: clipData.rows, cols: clipData.cols, data: clipData.data, blockData: clipData.blockData, mask: clipData.mask };
        }
      }
      const d = parseGridText(text);
      if (d && d.rows > 0 && d.cols > 0) return d;
    }
  } catch (e) {}
  if (clipData && clipData.data && clipData.data.length) {
    return { rows: clipData.rows, cols: clipData.cols, data: clipData.data, blockData: clipData.blockData, mask: clipData.mask };
  }
  return null;
}
function copySelection() {
  const isOv = activeGroupId === '__overview__';
  if (isOv) return copyOverviewSelection();

  const cells = getSelectedCells();
  if (cells.length === 0) return;

  const minR = Math.min(...cells.map(c => c.r)), maxR = Math.max(...cells.map(c => c.r));
  const minC = Math.min(...cells.map(c => c.c)), maxC = Math.max(...cells.map(c => c.c));
  const dates = weekDates(currentWeek);
  const rows = maxR - minR + 1, cols = maxC - minC + 1;
  const data = Array.from({ length: rows }, () => Array(cols).fill(''));
  const blockData = Array.from({ length: rows }, () => Array(cols).fill(null));
  cells.forEach(({ r, c, person }) => {
    const entries = getCellEntries(person.id, fmtFull(dates[c]));
    data[r - minR][c - minC] = joinNotes(entries.map(e => e.note));
    if (entries.length > 0) blockData[r - minR][c - minC] = entries.map(e => ({ note: e.note }));
  });
  const mask = ScheduleGridClipboard.buildMask(rows, cols, cells, minR, minC);
  clipData = { rows, cols, data, blockData, mask };
  writeClipboardGrid(clipData);
  toast(`已复制 ${cells.length} 个单元格`);
}

function copyOverviewSelection() {
  const cells = getOverviewSelectedCells();
  if (cells.length === 0) return;
  const minR = Math.min(...cells.map(c => c.r)), maxR = Math.max(...cells.map(c => c.r));
  const minC = Math.min(...cells.map(c => c.c)), maxC = Math.max(...cells.map(c => c.c));
  const rows = maxR - minR + 1, cols = maxC - minC + 1;
  const data = Array.from({ length: rows }, () => Array(cols).fill(''));
  const blockData = Array.from({ length: rows }, () => Array(cols).fill(null));
  cells.forEach(({ r, c, person, dateStr }) => {
    const blocks = getScheduleInfo(person.id, dateStr);
    data[r - minR][c - minC] = joinNotes(blocks.map(b => b.note || ''));
    if (blocks.length > 0) blockData[r - minR][c - minC] = blocks.map(b => ({ note: b.note }));
  });
  const mask = ScheduleGridClipboard.buildMask(rows, cols, cells, minR, minC);
  clipData = { rows, cols, data, blockData, mask };
  writeClipboardGrid(clipData);
  toast(`已复制 ${cells.length} 个单元格`);
}

async function pasteToSelection() {
  if (!requireScheduleWeekEdit()) return;
  const isOv = activeGroupId === '__overview__';
  const clip = await readClipboardGrid();
  if (!clip) return;

  let cells = isOv ? getOverviewSelectedCells() : getSelectedCells();

  // 无选区时，从激活单元格开始（单格起点）
  if (cells.length === 0 && activeCell) {
    const dates = weekDates(currentWeek);
    const people = weekPeople();
    const person = people[activeCell.r];
    if (person && activeCell.c < 7) {
      const cell = { r: activeCell.r, c: activeCell.c, person, dateStr: fmtFull(dates[activeCell.c]) };
      if (isOv) {
        const el = document.querySelector(`#overviewTable [data-r="${activeCell.r}"][data-c="${activeCell.c}"]`);
        cell.gid = el ? (el.dataset.gid || '') : '';
      }
      cells = [cell];
    }
  }
  if (cells.length === 0) { toast('请先选中目标单元格'); return; }

  const dates = weekDates(currentWeek);
  const people = weekPeople();
  const resolveCell = (r, c) => {
    const person = people[r];
    if (!person || c < 0 || c >= 7) return null;
    const cell = { r, c, person, dateStr: fmtFull(dates[c]) };
    if (isOv) {
      const el = document.querySelector(`#overviewTable [data-r="${r}"][data-c="${c}"]`);
      cell.gid = el ? (el.dataset.gid || '') : '';
    }
    return cell;
  };
  const pastePlan = ScheduleGridClipboard.buildPastePlan(cells, clip, resolveCell);
  const expandedFromSingleAnchor = cells.length === 1 && pastePlan.length > 1;

  const changes = [];
  let blockedByTimeOff = 0;
  const useBlocks = Boolean(clip.blockData);
  pastePlan.forEach(({ cell: { person, dateStr, gid }, sr, sc }) => {
    const srcBlocks = useBlocks ? clip.blockData[sr][sc] : null;
    const incomingText = clip.data[sr][sc] || '';
    if (getTimeOff(person.id, dateStr) && ((srcBlocks && srcBlocks.length > 0) || incomingText)) {
      blockedByTimeOff += 1;
      return;
    }
    if (isOv) {
      const groupId = gid || (weekGroups()[0] ? weekGroups()[0].id : '');
      const oldEntries = getEntries(groupId, person.id, dateStr);
      const oldVal = oldEntries.map(e => e.note).join('\n');
      if (srcBlocks && srcBlocks.length > 0) {
        const newEntries = srcBlocks.map(b => ({ note: (b.note || '').replace(/\u2424/g, '\n') }));
        const newVal = newEntries.map(e => e.note).join('\n');
        if (oldVal !== newVal) {
          setEntries(groupId, person.id, dateStr, newEntries);
          changes.push({ personId: person.id, dateStr, groupId, oldVal: oldEntries, newVal: newEntries });
        }
      } else {
        const newVal = clip.data[sr][sc] || '';
        if (oldVal !== newVal) {
          setEntries(groupId, person.id, dateStr, newVal ? [{ note: newVal }] : []);
          changes.push({ personId: person.id, dateStr, groupId, oldVal: oldEntries, newVal: newVal ? [{ note: newVal }] : [] });
        }
      }
    } else {
      const oldEntries = getCellEntries(person.id, dateStr);
      const oldVal = oldEntries.map(e => e.note).join('\n');
      if (srcBlocks && srcBlocks.length > 0) {
        const newEntries = srcBlocks.map(b => ({ note: (b.note || '').replace(/\u2424/g, '\n') }));
        const newVal = newEntries.map(e => e.note).join('\n');
        if (oldVal !== newVal) {
          setCellEntries(person.id, dateStr, newEntries);
          changes.push({ personId: person.id, dateStr, oldVal: oldEntries, newVal: newEntries });
        }
      } else {
        const newVal = clip.data[sr][sc] || '';
        if (oldVal !== newVal) {
          setCellEntries(person.id, dateStr, newVal ? [{ note: newVal }] : []);
          changes.push({ personId: person.id, dateStr, oldVal: oldEntries, newVal: newVal ? [{ note: newVal }] : [] });
        }
      }
    }
  });

  if (changes.length > 0) {
    pushUndo(changes);
    saveData();
  }
  if (expandedFromSingleAnchor) {
    const anchor = pastePlan[0].cell;
    sel = { r1: anchor.r, c1: anchor.c, r2: anchor.r, c2: anchor.c };
    selAnchor = { r: anchor.r, c: anchor.c };
    activeCell = { r: anchor.r, c: anchor.c };
    selExtra = new Set(pastePlan.slice(1).map(({ cell }) => `${cell.r},${cell.c}`));
  }
  if (isOv) { renderAll(); highlightOverviewSelection(); }
  else renderEditTable();
  toast(blockedByTimeOff
    ? `已粘贴 ${changes.length} 个单元格，跳过 ${blockedByTimeOff} 个休假格`
    : `已粘贴 ${changes.length} 个单元格`);
}

// ========================= 填充 =========================
function fillDown() {
  if (!requireScheduleWeekEdit()) return;
  if (!sel || (sel.r2 - sel.r1 === 0 && sel.c2 - sel.c1 === 0)) return;

  const dates = weekDates(currentWeek);
  const changes = [];

  const people = weekPeople();
  // 对每一列，用该列第一行的值填充到下面所有行
  for (let c = sel.c1; c <= sel.c2; c++) {
    if (sel.r1 >= people.length) break;
    const srcEntries = getCellEntries(people[sel.r1].id, fmtFull(dates[c]));
    const dateStr = fmtFull(dates[c]);

    for (let r = sel.r1 + 1; r <= sel.r2; r++) {
      if (r >= people.length) break;
      const personId = people[r].id;
      const oldEntries = getCellEntries(personId, dateStr);
      if (srcEntries.length && getTimeOff(personId, dateStr)) continue;
      if (JSON.stringify(oldEntries) !== JSON.stringify(srcEntries)) {
        setCellEntries(personId, dateStr, srcEntries);
        changes.push({ personId, dateStr, oldVal: oldEntries, newVal: srcEntries });
      }
    }
  }

  if (changes.length > 0) {
        pushUndo(changes);
    saveData();
    renderEditTable();
    toast('已填充');
  }
}

// 填充柄拖拽填充
function startFillDrag(e) {
  if (!sel) return;
  if (!requireScheduleWeekEdit()) return;
  fillDragging = true;
  fillStart = { r: sel.r2, c: sel.c2 };
  fillEnd = null;
  e.preventDefault();
}

function updateFillDrag(e) {
  if (!fillDragging) return;

  // 根据鼠标位置估算目标行列
  let cellEl = document.elementFromPoint(e.clientX, e.clientY);
  if (!cellEl) cellEl = estimateCellFromPoint(e.clientX, e.clientY);
  if (!cellEl) return;

  const endR = parseInt(cellEl.dataset.r);
  const endC = parseInt(cellEl.dataset.c);

  // 限制在有效范围内
  const people = weekPeople();
  const clampedR = Math.max(0, Math.min(people.length - 1, endR));
  const clampedC = Math.max(0, Math.min(6, endC));

  fillEnd = { r: clampedR, c: clampedC };

  // 预览高亮整个目标区域
  renderEditTable();
  const pr1 = Math.min(sel.r1, fillEnd.r);
  const pc1 = Math.min(sel.c1, fillEnd.c);
  const pr2 = Math.max(sel.r2, fillEnd.r);
  const pc2 = Math.max(sel.c2, fillEnd.c);
  if (pr2 > sel.r2 || pr1 < sel.r1 || pc2 > sel.c2 || pc1 < sel.c1) {
    highlightFillPreview(pr1, pc1, pr2, pc2);
  }
}

function endFillDrag() {
  if (!requireScheduleWeekEdit()) {
    fillDragging = false; fillStart = null; fillEnd = null;
    renderEditTable();
    return;
  }
  if (!fillDragging || !fillEnd) {
    fillDragging = false; fillStart = null; fillEnd = null;
    renderEditTable();
    return;
  }

  const dates = weekDates(currentWeek);
  const changes = [];
  const people = weekPeople();
  const maxR = people.length - 1;

  // 填充范围（支持四向）
  const fr1 = Math.min(sel.r1, fillEnd.r);
  const fc1 = Math.min(sel.c1, fillEnd.c);
  const fr2 = Math.max(sel.r2, fillEnd.r);
  const fc2 = Math.max(sel.c2, fillEnd.c);

  for (let r = fr1; r <= fr2; r++) {
    for (let c = fc1; c <= fc2; c++) {
      // 跳过原选区内的格子
      if (r >= sel.r1 && r <= sel.r2 && c >= sel.c1 && c <= sel.c2) continue;
      if (r > maxR || c > 6) continue;

      // 源：按原选区循环映射
      const srcR = sel.r1 + (((r - sel.r1) % (sel.r2 - sel.r1 + 1)) + (sel.r2 - sel.r1 + 1)) % (sel.r2 - sel.r1 + 1);
      const srcC = sel.c1 + (((c - sel.c1) % (sel.c2 - sel.c1 + 1)) + (sel.c2 - sel.c1 + 1)) % (sel.c2 - sel.c1 + 1);

      if (srcR > maxR || srcC > 6) continue;

      const srcEntries = getCellEntries(people[srcR].id, fmtFull(dates[srcC]));

      const personId = people[r].id;
      const dateStr = fmtFull(dates[c]);
      const oldEntries = getCellEntries(personId, dateStr);
      if (srcEntries.length && getTimeOff(personId, dateStr)) continue;

      if (JSON.stringify(oldEntries) !== JSON.stringify(srcEntries)) {
        setCellEntries(personId, dateStr, srcEntries);
        changes.push({ personId, dateStr, oldVal: oldEntries, newVal: srcEntries });
      }
    }
  }

  if (changes.length > 0) {
        pushUndo(changes);
    saveData();
    toast(`已填充 ${changes.length} 个单元格`);
  }

  fillDragging = false; fillStart = null; fillEnd = null;
  sel = { r1: fr1, c1: fc1, r2: fr2, c2: fc2 };
  activeCell = { r: fr1, c: fc1 };
  renderEditTable();
}

function highlightFillPreview(r1, c1, r2, c2) {
  // 高亮填充预览范围（排除原选区）
  const els = document.querySelectorAll('#editTable [data-r]');
  els.forEach(el => {
    const r = parseInt(el.dataset.r);
    const c = parseInt(el.dataset.c);
    // 在预览范围内但不在原选区内
    if (r >= r1 && r <= r2 && c >= c1 && c <= c2 &&
        !(r >= sel.r1 && r <= sel.r2 && c >= sel.c1 && c <= sel.c2)) {
      el.classList.add('selected');
      el.style.opacity = '0.5';
    }
  });
}

function updateFillHandle() {
  const handle = document.getElementById('fillHandle');
  if (!sel || (sel.r1 === sel.r2 && sel.c1 === sel.c2 && !sel)) {
    handle.style.display = 'none';
    return;
  }

  // 找右下角单元格
  const cellEl = document.querySelector(`#editTable [data-r="${sel.r2}"][data-c="${sel.c2}"]`);
  if (!cellEl) { handle.style.display = 'none'; return; }

  const tableWrap = document.querySelector('.table-wrap');
  const wrapRect = tableWrap.getBoundingClientRect();
  const cellRect = cellEl.getBoundingClientRect();

  handle.style.display = 'block';
  handle.style.left = (cellRect.right - wrapRect.left - 4) + 'px';
  handle.style.top = (cellRect.bottom - wrapRect.top - 4) + 'px';
}

// ========================= 渲染编辑表格 =========================
function renderEditTable() {
  const group = weekGroups().find(g => g.id === activeGroupId);
  if (!group) return;

  const gi = weekGroups().findIndex(g => g.id === activeGroupId);
  const color = COLORS[gi % COLORS.length];
  const dates = weekDates(currentWeek);

  const people = weekPeople();
  let html = '<thead><tr><th>姓名</th>';
  dates.forEach((d, i) => html += calendarHeaderHTML(d, i));
  html += '</tr></thead><tbody>';

  if (people.length === 0) {
    html += '<tr><td colspan="8" style="padding:40px;color:var(--text2);text-align:center;">暂无人员，点击下方添加</td></tr>';
    html += `<tr class="add-row" onclick="quickAddPerson('internal')">
      <td colspan="8" style="padding:4px;text-align:center;color:var(--text2);cursor:pointer;border:none;">
        <span class="add-hint">+ 添加内部人员</span>
      </td>
    </tr>`;
    html += `<tr class="add-row" onclick="quickAddPerson('external')">
      <td colspan="8" style="padding:4px;text-align:center;color:var(--text2);cursor:pointer;border:none;background:#fefce8;">
        <span class="add-hint">+ 添加外协人员</span>
      </td>
    </tr>`;
  } else {
    let lastCat = null;
    people.forEach((person, r) => {
      // 分类分隔行
      if (person._cat !== lastCat) {
        const label = person._cat === 'internal' ? '内部人员' : '外协人员';
        html += `<tr class="section-row"><td colspan="8" style="padding:8px 16px;background:#f3f4f6;font-size:12px;font-weight:600;color:var(--text2);text-align:left;border-bottom:2px solid var(--border);">${label}</td></tr>`;
        lastCat = person._cat;
      }
      html += `<tr class="${person._cat === 'external' ? 'row-external' : ''}"><td>${personNameHTML(person)}<span class="row-del" onclick="event.stopPropagation();removePersonFromWeek('${person.id}')" title="从本周移除">×</span></td>`;
      dates.forEach((date, c) => {
        const ds = fmtFull(date);
        const entries = getCellEntries(person.id, ds);
        const timeOff = getTimeOff(person.id, ds);
        const selClass = isSelected(r, c) ? ' selected' : '';
        const activeClass = (activeCell && activeCell.r === r && activeCell.c === c) ? ' active-cell' : '';
        const isEdit = editing && editing.personId === person.id && editing.dateStr === ds;
        const editClass = isEdit ? ' editing' : '';
        const conflictClass = (timeOff && entries.length) ? ' timeoff-conflict-cell' : '';
        const emptyClass = (entries.length === 0 && !timeOff && !isEdit) ? ' cell-empty' : '';
        html += `<td><div class="cell${selClass}${activeClass}${editClass}${emptyClass}${conflictClass}"
          data-r="${r}" data-c="${c}" data-pid="${person.id}" data-date="${ds}"
          style="position:relative;">`;
        if (isEdit) {
          html += `<textarea placeholder="输入任务" id="editInput"></textarea>`;
        } else if (entries.length === 0 && !timeOff) {
          html += '-';
        } else {
          html += timeOffChipHTML(timeOff, true);
          entries.forEach((e, idx) => {
            const condColor = getConditionColor(e.note);
            const style = condColor
              ? `color:#222;background:${hexToRgba(condColor,0.30)};font-weight:600;`
              : `color:${color};background:${hexToRgba(color,0.12)};border-left:3px solid ${color};`;
            html += `<div class="et-block" style="${style}" data-idx="${idx}">${esc(e.note.replace(/\r/g, '').replace(/^\n+|\n+$/g, '')).replace(/\n/g, '<br>')}</div>`;
          });
        }
        html += '</div></td>';
      });
      html += '</tr>';
    });
    // 底部始终显示两个添加按钮
    html += `<tr class="add-row" onclick="quickAddPerson('internal')">
      <td colspan="8" style="padding:4px;text-align:center;color:var(--text2);cursor:pointer;border:none;">
        <span class="add-hint">+ 添加内部人员</span>
      </td>
    </tr>`;
    html += `<tr class="add-row" onclick="quickAddPerson('external')">
      <td colspan="8" style="padding:4px;text-align:center;color:var(--text2);cursor:pointer;border:none;background:#fefce8;">
        <span class="add-hint">+ 添加外协人员</span>
      </td>
    </tr>`;
  }
  html += '</tbody>';

  document.getElementById('editTable').innerHTML = html;
  updateFillHandle();

  if (editing) {
    const ta = document.getElementById('editInput');
    if (ta) {
      const entries = getCellEntries(editing.personId, editing.dateStr);
      const v = (editing.idx >= 0 && entries[editing.idx]) ? entries[editing.idx].note : '';
      ta.value = v;
      ta.focus();
      ta.selectionStart = ta.value.length;
    }
  }

  // 重新绑定填充柄事件
  const handle = document.getElementById('fillHandle');
  handle.onmousedown = startFillDrag;
  handle.onmouseup = endFillDrag;
  if (typeof renderRemoteCellPresence === 'function') renderRemoteCellPresence();
}

// ========================= 鼠标交互 =========================
let clickTimer = null;
let mouseDownCell = null;     // { r, c, personId, dateStr, el }
let mouseMoved = false;
let lastClickCell = null;

// 拖拽移动
let cellDrag = null;          // { personId, dateStr, r, c, val, sourceEl }
let dragStarted = false;
const DRAG_THRESHOLD = 5;
const GRAB_EDGE = 6;          // 边缘多少像素内不算中心区

// 判断鼠标是否在单元格中心区域（非边缘）
function isInGrabZone(cellEl, e) {
  const rect = cellEl.getBoundingClientRect();
  const nearEdge =
    e.clientX - rect.left < GRAB_EDGE ||
    rect.right - e.clientX < GRAB_EDGE ||
    e.clientY - rect.top < GRAB_EDGE ||
    rect.bottom - e.clientY < GRAB_EDGE;
  return !nearEdge;
}

function findCellAtPoint(x, y) {
  // 使用 elementsFromPoint 获取该坐标上的所有元素（包括被 overflow 裁剪的）
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    const cell = el.closest('[data-r]');
    if (cell) return cell;
  }
  return null;
}

// 当鼠标在表格外时，估算最近的有效行列
function estimateCellFromPoint(x, y) {
  const tableEl = document.getElementById('editTable');
  if (!tableEl) return null;
  const rect = tableEl.getBoundingClientRect();
  const people = weekPeople();

  let r, c;
  // 估算行：计算相对于表格顶部的偏移
  if (y < rect.top) {
    r = 0;
  } else if (y > rect.bottom) {
    r = people.length - 1;
  } else {
    // 在表格内但找不到 data-r（可能在名字列或分隔行），用 y 比例估算
    const theadH = tableEl.querySelector('thead')?.getBoundingClientRect().height || 40;
    const rowH = 62; // 估算行高
    r = Math.floor((y - rect.top - theadH) / rowH);
    r = Math.max(0, Math.min(people.length - 1, r));
  }

  // 估算列：计算相对于表格左边的偏移
  if (x < rect.left + 90) {
    c = 0; // 名字列左侧 → 第一列
  } else if (x > rect.right) {
    c = 6; // 表格右侧 → 最后一列
  } else {
    const colW = (rect.width - 90) / 7;
    c = Math.floor((x - rect.left - 90) / colW);
    c = Math.max(0, Math.min(6, c));
  }

  // 查找对应单元格
  const cellEl = tableEl.querySelector(`[data-r="${r}"][data-c="${c}"]`);
  return cellEl;
}

function syncDraggingCell(cellEl) {
  if (!cellDrag || !cellEl) return;
  const personId = cellEl.dataset.pid;
  const dateStr = cellEl.dataset.date;
  if (!personId || !dateStr) return;
  const key = `${personId}\u0000${dateStr}`;
  if (cellDrag.presenceTargetKey === key) return;
  cellDrag.presenceTargetKey = key;
  syncPresenceCell(personId, dateStr, 'dragging');
}

// 全局 mousemove：检测抓手区域 + 拖拽/选区
document.addEventListener('mousemove', function(e) {
  // 总览拖拽
  if (ovDrag) {
    if (!ovDrag._startX) { ovDrag._startX = e.clientX; ovDrag._startY = e.clientY; return; }
    const dx = e.clientX - ovDrag._startX;
    const dy = e.clientY - ovDrag._startY;

    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

    if (!ovDragStarted && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
      ovDragStarted = true;
      ovDrag.sourceEl.style.opacity = '0.3';
      ovDrag.sourceEl.style.border = '2px dashed var(--primary)';
    }

    if (ovDragStarted) {
      document.querySelectorAll('#overviewTable .drag-target').forEach(el => {
        el.classList.remove('drag-target'); el.style.background = ''; el.style.border = '';
      });
      const targetEl = document.elementFromPoint(e.clientX, e.clientY);
      if (targetEl) {
        const cell = targetEl.closest('#overviewTable [data-pid]');
        if (cell && cell !== ovDrag.sourceEl) {
          cell.classList.add('drag-target');
          cell.style.background = '#eef2ff';
          cell.style.border = '2px dashed var(--primary)';
        }
      }
    }
    return;
  }

  if (editing) return;
  if (fillDragging) { updateFillDrag(e); return; }

  // === 拖拽移动进行中 ===
  if (cellDrag && mouseDownCell) {
    if (!cellDrag._startX) {
      cellDrag._startX = e.clientX;
      cellDrag._startY = e.clientY;
      return;
    }

    const dx = e.clientX - cellDrag._startX;
    const dy = e.clientY - cellDrag._startY;

    if (!dragStarted && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
      dragStarted = true;
      cellDrag.sourceEl.style.opacity = '0.3';
      cellDrag.sourceEl.style.border = '2px dashed var(--primary)';
      cellDrag.sourceEl.style.cursor = 'grabbing';
      syncDraggingCell(cellDrag.sourceEl);
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    }

    if (dragStarted) {
      document.querySelectorAll('#editTable [data-r].drag-target').forEach(el => {
        el.classList.remove('drag-target');
        el.style.background = '';
        el.style.border = '';
      });
      const targetEl = findCellAtPoint(e.clientX, e.clientY);
      syncDraggingCell(targetEl || cellDrag.sourceEl);
      if (targetEl && targetEl !== cellDrag.sourceEl) {
        targetEl.classList.add('drag-target');
        targetEl.style.background = '#eef2ff';
        targetEl.style.border = '2px dashed var(--primary)';
      }
    }
    return;
  }

  // === 空闲状态：检测抓手区域 ===
  if (!mouseDownCell && !cellDrag) {
    const cellEl = e.target.closest('#editTable [data-r]');
    // 先清除上一个抓手格子的样式
    document.querySelectorAll('#editTable [data-r].grab-zone').forEach(el => {
      el.classList.remove('grab-zone');
      el.style.cursor = '';
    });

    if (cellEl) {
      const entry = getCell(cellEl.dataset.pid, cellEl.dataset.date);
      if (entry && entry.note && isInGrabZone(cellEl, e)) {
        cellEl.classList.add('grab-zone');
        cellEl.style.cursor = 'grab';
      }
    }
    return;
  }

  // === 选区拖拽 ===
  if (!mouseDownCell) return;
  let cellEl = findCellAtPoint(e.clientX, e.clientY);
  if (!cellEl) cellEl = estimateCellFromPoint(e.clientX, e.clientY);
  if (!cellEl) return;
  const r = parseInt(cellEl.dataset.r);
  const c = parseInt(cellEl.dataset.c);
  if (r !== mouseDownCell.r || c !== mouseDownCell.c) {
    mouseMoved = true;
    selectRange(r, c);
    syncPresenceCell(cellEl.dataset.pid, cellEl.dataset.date);
    updateSelectionVisual();
  }
});

document.addEventListener('mousedown', function(e) {
  if (fillDragging) return;
  if (e.target.closest('#fillHandle') || e.target.closest('.fill-handle')) return;
  if (editing) return;
  if (e.target.closest('#overviewTable textarea')) return;

  // ===== 总览表单元格 =====
  // 必须用 .ov-cell 而不是 [data-pid]，否则点击小组块时会拿到没有 data-r/data-c 的块元素
  const ovCell = e.target.closest('#overviewTable .ov-cell');
  if (ovCell && activeGroupId === '__overview__') {
    const pid = ovCell.dataset.pid;
    const date = ovCell.dataset.date;
    if (!pid || !date) return;
    const r = parseInt(ovCell.dataset.r);
    const c = parseInt(ovCell.dataset.c);

    mouseDownCell = { r, c, personId: pid, dateStr: date, el: ovCell };
    lastClickCell = { ...mouseDownCell };
    mouseMoved = false;
    dragStarted = false;
    cellDrag = null;

    // Ctrl+点击 → 追加选区
    if (e.ctrlKey || e.metaKey) {
      const key = `${r},${c}`;
      if (selExtra.has(key)) selExtra.delete(key); else selExtra.add(key);
      activeCell = { r, c };
      if (!sel) sel = { r1: r, c1: c, r2: r, c2: c };
      highlightOverviewSelection();
      return;
    }

    // 普通点击 → 立刻选中
    selExtra = new Set();
    sel = { r1: r, c1: c, r2: r, c2: c };
    activeCell = { r, c };
    highlightOverviewSelection();

    // 准备拖拽（mousemove 超过阈值才真正开始）。拖拽以「单块」为单位。
    const blk = e.target.closest('.ov-block');
    if (blk && blk.dataset.gid && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      ovDrag = {
        groupId: blk.dataset.gid, personId: pid, dateStr: date,
        note: blk.dataset.note || '', idx: parseInt(blk.dataset.idx) || 0,
        sourceEl: blk, r, c
      };
    }
    return;
  }

  // ===== 小组表单元格 =====
  const cellEl = e.target.closest('#editTable [data-r]');
  if (!cellEl) return;

  const r = parseInt(cellEl.dataset.r);
  const c = parseInt(cellEl.dataset.c);
  const personId = cellEl.dataset.pid;
  const dateStr = cellEl.dataset.date;
  mouseDownCell = { r, c, personId, dateStr, el: cellEl };
  lastClickCell = { ...mouseDownCell };
  mouseMoved = false;
  dragStarted = false;
  cellDrag = null;

  const entries = getCellEntries(personId, dateStr);
  const hasContent = entries.length > 0;

  // 更新选区状态
  if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
    selExtra = new Set();
    selectCell(r, c);
    updateSelectionVisual();
  }

  // 仅在「抓手区域」（鼠标在格子中心 + 有内容）时才激活拖拽移动；以被点击的具体块为单位
  if (hasContent && !e.shiftKey && !e.ctrlKey && !e.metaKey && isInGrabZone(cellEl, e)) {
    const blk = e.target.closest('.et-block');
    const idx = blk ? parseInt(blk.dataset.idx) : 0;
    const note = (entries[idx] && entries[idx].note) || (entries[0] && entries[0].note) || '';
    cellDrag = {
      personId, dateStr, r, c, gid: activeGroupId, idx, note,
      sourceEl: cellEl,
    };
    cellEl.style.cursor = 'grabbing';
  }
});

document.addEventListener('mouseup', function(e) {
  if (fillDragging) { endFillDrag(); return; }
  

  // 总览拖拽移动释放：直接单块移动，不再弹窗
  if (ovDrag && ovDragStarted) {
    const targetEl = document.elementFromPoint(e.clientX, e.clientY);
    if (targetEl) {
      const targetCell = targetEl.closest('#overviewTable [data-pid]');
      const srcCell = ovDrag.sourceEl.closest('[data-pid]');
      if (targetCell && targetCell !== srcCell) {
        const tPid = targetCell.dataset.pid;
        const tDate = targetCell.dataset.date;
        if (tPid && tDate) {
          moveBlock(ovDrag.groupId, ovDrag.personId, ovDrag.dateStr, ovDrag.idx, tPid, tDate);
        }
      }
    }
    cleanupOvDrag();
    renderAll();
    mouseDownCell = null;
    return;
  }

  // 拖拽移动释放（小组表）：源移除被拖块，目标追加该块（即使同组也作为独立块，不覆盖）
  if (cellDrag && dragStarted) {
    if (!requireScheduleWeekEdit()) {
      cleanupDrag();
      mouseDownCell = null;
      renderEditTable();
      return;
    }
    const sourceSnapshot = { r: cellDrag.r, c: cellDrag.c, personId: cellDrag.personId, dateStr: cellDrag.dateStr };
    const targetEl = findCellAtPoint(e.clientX, e.clientY);
    let selectedAfterDrop = sourceSnapshot;
    if (targetEl && targetEl !== cellDrag.sourceEl) {
      const tPid = targetEl.dataset.pid;
      const tDate = targetEl.dataset.date;
      if (getTimeOff(tPid, tDate)) {
        toast('目标人员当天已休假，不能移入排班');
        cleanupDrag();
        mouseDownCell = null;
        renderEditTable();
        return;
      }
      const srcEntries = getEntries(cellDrag.gid, cellDrag.personId, cellDrag.dateStr);
      const moved = (srcEntries[cellDrag.idx] && srcEntries[cellDrag.idx].note) || cellDrag.note;
      const tgtEntries = getEntries(cellDrag.gid, tPid, tDate);

      const changes = [];
      const newTgt = tgtEntries.concat([{ note: moved }]);
      setEntries(cellDrag.gid, tPid, tDate, newTgt);
      changes.push({ personId: tPid, dateStr: tDate, groupId: cellDrag.gid, oldVal: tgtEntries, newVal: newTgt });
      const newSrc = srcEntries.filter((_, i) => i !== cellDrag.idx);
      setEntries(cellDrag.gid, cellDrag.personId, cellDrag.dateStr, newSrc);
      changes.push({ personId: cellDrag.personId, dateStr: cellDrag.dateStr, groupId: cellDrag.gid, oldVal: srcEntries, newVal: newSrc });

      pushUndo(changes, { type:'move', groupId: cellDrag.gid, content: moved, fromPerson: cellDrag.personId, fromDate: cellDrag.dateStr, toPerson: tPid, toDate: tDate });
      saveData();
      selectedAfterDrop = {
        r: parseInt(targetEl.dataset.r), c: parseInt(targetEl.dataset.c),
        personId: tPid, dateStr: tDate,
      };
    }
    cleanupDrag();
    mouseDownCell = null;
    selExtra = new Set();
    selectCell(selectedAfterDrop.r, selectedAfterDrop.c);
    renderEditTable();
    return;
  }

  // 总览鼠标按住但没有拖拽（仅选中），只清变量不渲染，避免冲掉 dblclick
  if (ovDrag && !ovDragStarted) {
    ovDrag = null;
    ovDragStarted = false;
  }

  if (cellDrag) {
    cleanupDrag();
  }
  mouseDownCell = null;
});

function cleanupDrag() {
  cellDrag = null;
  dragStarted = false;
  document.querySelectorAll('#editTable [data-r].drag-target').forEach(el => {
    el.classList.remove('drag-target');
    el.style.background = '';
    el.style.border = '';
  });
  document.querySelectorAll('#editTable [data-r]').forEach(el => {
    el.style.opacity = '';
    el.style.border = '';
    el.style.cursor = '';
  });
}

// 仅更新选区 CSS，不重建整个 DOM
function updateSelectionVisual() {
  const allCells = document.querySelectorAll('#editTable [data-r]');
  allCells.forEach(el => {
    const r = parseInt(el.dataset.r);
    const c = parseInt(el.dataset.c);
    const selClass = isSelected(r, c);
    const activeClass = activeCell && activeCell.r === r && activeCell.c === c;

    el.classList.toggle('selected', selClass);
    el.classList.toggle('active-cell', activeClass);
  });
  updateFillHandle();
}

// click 事件：区分单击/双击
document.addEventListener('click', function(e) {
  if (editing) return;
  // 汇总表的选区由 mousedown 维护，这里不要清空
  if (activeGroupId === '__overview__') return;

  const cellEl = e.target.closest('#editTable [data-r]');
  if (!cellEl) {
    if (!e.target.closest('#editTable') && !e.target.closest('#fillHandle') && !e.target.closest('.fill-handle')) {
      clearSelection();
      renderEditTable();
    }
    return;
  }

  const r = parseInt(cellEl.dataset.r);
  const c = parseInt(cellEl.dataset.c);

  // Shift+点击扩展选区（不受 mouseMoved 限制）
  if (e.shiftKey && activeCell) {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    mouseMoved = false;
    selExtra = new Set();
    selectRange(r, c);
    activeCell = { r, c };
    syncPresenceActiveCell();
    renderEditTable();
    return;
  }

  // Ctrl+点击：追加/取消选中（不受 mouseMoved 限制）
  if (e.ctrlKey || e.metaKey) {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    mouseMoved = false;
    const key = `${r},${c}`;
    if (selExtra.has(key)) {
      selExtra.delete(key);
    } else {
      selExtra.add(key);
    }
    activeCell = { r, c };
    if (!sel) selectCell(r, c);
    else syncPresenceActiveCell();
    renderEditTable();
    return;
  }

  // 普通点击：拖拽过则不触发
  if (mouseMoved) { mouseMoved = false; return; }

  // 用 timer 延迟渲染，给 dblclick 留时间（overview 不需要单击延迟渲染）
  if (clickTimer) { clearTimeout(clickTimer); }
  if (activeGroupId === '__overview__') return;
  clickTimer = setTimeout(() => {
    clickTimer = null;
    renderEditTable();
  }, 180);
});

// 双击：使用 lastClickCell（mousedown 时保存）的信息，不依赖可能已被销毁的 DOM
document.addEventListener('dblclick', function(e) {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

  if (!lastClickCell) return;
  if (!requireScheduleWeekEdit()) return;
  const { personId, dateStr, r, c } = lastClickCell;

  // 总览表双击编辑
  if (activeGroupId === '__overview__') {
    ovDrag = null; ovDragStarted = false;
    // 双击具体小组块 → 仅编辑该块
    const blk = e.target.closest('.ov-block');
    if (blk && blk.dataset.gid) {
      ovEntryEdit(blk, blk.dataset.pid, blk.dataset.date, blk.dataset.gid, parseInt(blk.dataset.idx) || 0);
      return;
    }
    const ovCell = e.target.closest('#overviewTable [data-pid]');
    if (!ovCell) return;
    const pid = ovCell.dataset.pid;
    const ds = ovCell.dataset.date;
    if (!pid || !ds) return;
    ovPickGroupForNew(pid, ds, ovCell); // 空单元格 → 先选小组再新增（保证归属正确）
    return;
  }

  // 小组表双击编辑
  selectCell(r, c);
  renderEditTable();
  const cellEl = document.querySelector(`#editTable [data-pid="${personId}"][data-date="${dateStr}"]`);
  if (cellEl) {
    // 双击具体块 → 编辑该块；否则编辑首个块（有内容时）或新增块
    const blk = e.target.closest('.et-block');
    let idx = -1;
    if (blk) idx = parseInt(blk.dataset.idx);
    else {
      const entries = getCellEntries(personId, dateStr);
      idx = entries.length ? 0 : -1;
    }
    startEditDOM(cellEl, personId, dateStr, idx);
  }
});

// ========================= 编辑 =========================
function startEditDOM(cellEl, personId, dateStr, idx) {
  if (!requireScheduleWeekEdit()) return;
  if (idx < 0 && getTimeOff(personId, dateStr)) {
    toast('该人员当天已标记休假，请先在总览取消休假');
    return;
  }
  if (editing) commitEdit();

  editing = { personId, dateStr, idx, el: cellEl };
  if (typeof presenceStartEditing === 'function') {
    presenceStartEditing({ mode: 'group', personId, dateStr, groupId: activeGroupId, taskIndex: idx });
  }
  renderEditTable();

  const ta = document.getElementById('editInput');
  if (!ta) return;

  const entries = getCellEntries(personId, dateStr);
  const oldVal = (idx >= 0 && entries[idx]) ? entries[idx].note : '';
  ta.value = oldVal;
  ta.focus();
  // 光标移到末尾
  ta.selectionStart = ta.value.length;
  autoResizeTextarea(ta);
  ta.addEventListener('input', () => autoResizeTextarea(ta));

  ta.addEventListener('blur', () => {
    setTimeout(() => { if (editing) commitEdit(); }, 100);
  });

  ta.addEventListener('keydown', function(e) {
    // Ctrl+Enter 提交
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commitEdit();
      moveActiveCell(1, 0);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commitEdit();
      moveActiveCell(0, e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  });
}

function commitEdit() {
  if (!editing) return;
  if (!requireScheduleWeekEdit()) { cancelEdit(); return; }

  const { personId, dateStr, idx } = editing;
  const ta = document.getElementById('editInput');
  const newVal = ta ? ta.value.trim() : '';

  const entries = getCellEntries(personId, dateStr);
  const oldVal = (idx >= 0 && entries[idx]) ? entries[idx].note : '';

  let next;
  if (idx < 0) {
    if (!newVal) { editing = null; presenceStopEditing(); renderEditTable(); return; }
    next = entries.concat([{ note: newVal }]);
  } else {
    if (oldVal === newVal) { editing = null; presenceStopEditing(); renderEditTable(); return; }
    next = entries.slice();
    if (newVal) next[idx] = { note: newVal };
    else next.splice(idx, 1);
  }
  setCellEntries(personId, dateStr, next);
  pushUndo([{ personId, dateStr, oldVal: entries, newVal: next }]);
  saveData();

  editing = null;
  presenceStopEditing();
  renderEditTable();
}

function cancelEdit() {
  editing = null;
  presenceStopEditing();
  renderEditTable();
}

function moveActiveCell(dr, dc) {
  if (!activeCell) {
    if (sel) activeCell = { r: sel.r1, c: sel.c1 };
    else { activeCell = { r: 0, c: 0 }; }
  }

  const total = allPeople().length;
  if (total === 0) return;
  activeCell.r = Math.max(0, Math.min(total - 1, activeCell.r + dr));
  activeCell.c = Math.max(0, Math.min(6, activeCell.c + dc));
  sel = { r1: activeCell.r, c1: activeCell.c, r2: activeCell.r, c2: activeCell.c };
  selAnchor = { r: activeCell.r, c: activeCell.c };
  syncPresenceActiveCell();

  setTimeout(() => {
    renderEditTable();
    // 如果在编辑模式下，重新进入编辑
    if (editing) {
      const dates = weekDates(currentWeek);
      const people = weekPeople();
      const personId = people[activeCell.r].id;
      const dateStr = fmtFull(dates[activeCell.c]);
      const cellEl = document.querySelector(`#editTable [data-pid="${personId}"][data-date="${dateStr}"]`);
      if (cellEl) startEditDOM(cellEl, personId, dateStr, getCellEntries(personId, dateStr).length ? 0 : -1);
    }
  }, 30);
}

// ========================= 键盘快捷键 =========================
document.addEventListener('keydown', function(e) {
  // 编辑模式下大部分快捷键交给input处理
  if (editing) return;
  // 总览 textarea 编辑中
  if (document.activeElement && document.activeElement.closest('#overviewTable textarea')) return;

  // 弹窗模式下不处理
  if (document.getElementById('manageModal').style.display === 'flex') return;

  const isCtrl = e.ctrlKey || e.metaKey;

  // Ctrl+C
  if (isCtrl && e.key === 'c') {
    e.preventDefault();
    copySelection();
    return;
  }

  // Ctrl+V
  if (isCtrl && e.key === 'v') {
    e.preventDefault();
    pasteToSelection();
    return;
  }

  // Ctrl+D (fill down)
  if (isCtrl && e.key === 'd') {
    e.preventDefault();
    fillDown();
    return;
  }

  // Ctrl+Z
  if (isCtrl && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
    return;
  }

  // Ctrl+Y (or Ctrl+Shift+Z)
  if ((isCtrl && e.key === 'y') || (isCtrl && e.key === 'z' && e.shiftKey)) {
    e.preventDefault();
    redo();
    return;
  }

  // Delete / Backspace
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!sel) return;
    e.preventDefault();
    if (!requireScheduleWeekEdit()) return;
    if (activeGroupId === '__overview__') {
      // 汇总表：清除选中格中「所有小组」的全部块
      const cells = getOverviewSelectedCells();
      const changes = [];
      cells.forEach(({ person, dateStr }) => {
        weekGroups().forEach(g => {
          const oldEntries = getEntries(g.id, person.id, dateStr);
          if (oldEntries.length) {
            setEntries(g.id, person.id, dateStr, []);
            changes.push({ personId: person.id, dateStr, groupId: g.id, oldVal: oldEntries, newVal: [] });
          }
        });
      });
      if (changes.length > 0) { pushUndo(changes); saveData(); renderAll(); }
      return;
    }
    // 小组表：清除选中格内容（整格 entries）
    const cells = getSelectedCells();
    const changes = [];
    cells.forEach(({ person, dateStr }) => {
      const oldEntries = getCellEntries(person.id, dateStr);
      if (oldEntries.length) {
        setCellEntries(person.id, dateStr, []);
        changes.push({ personId: person.id, dateStr, oldVal: oldEntries, newVal: [] });
      }
    });
    if (changes.length > 0) {
            pushUndo(changes);
      saveData();
      renderEditTable();
    }
    return;
  }

  // 方向键移动选区
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    e.preventDefault();
    if (!activeCell) {
      activeCell = sel ? { r: sel.r1, c: sel.c1 } : { r: 0, c: 0 };
    }
    const dr = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    const dc = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    moveActiveCell(dr, dc);
    return;
  }

  // Tab 跳格（总览和小组都支持）
  if (e.key === 'Tab') {
    e.preventDefault();
    if (!activeCell) activeCell = sel ? { r: sel.r1, c: sel.c1 } : { r: 0, c: 0 };
    moveActiveCell(0, e.shiftKey ? -1 : 1);
    return;
  }

  // Enter 进入编辑
  if (e.key === 'Enter' && !isCtrl) {
    e.preventDefault();
    if (!activeCell && sel) activeCell = { r: sel.r1, c: sel.c1 };
    if (!activeCell) activeCell = { r: 0, c: 0 };
    const people = weekPeople();
    if (people.length === 0) return;
    const dates = weekDates(currentWeek);
    const pid = people[activeCell.r].id;
    const ds = fmtFull(dates[activeCell.c]);
    const cellEl = document.querySelector(`#editTable [data-pid="${pid}"][data-date="${ds}"]`);
    if (cellEl) startEditDOM(cellEl, pid, ds, getCellEntries(pid, ds).length ? 0 : -1);
    return;
  }

  // F2 进入编辑
  if (e.key === 'F2') {
    e.preventDefault();
    if (!activeCell && sel) activeCell = { r: sel.r1, c: sel.c1 };
    if (!activeCell) activeCell = { r: 0, c: 0 };
    const people = weekPeople();
    if (people.length === 0) return;
    const dates = weekDates(currentWeek);
    const pid = people[activeCell.r].id;
    const ds = fmtFull(dates[activeCell.c]);
    const cellEl = document.querySelector(`#editTable [data-pid="${pid}"][data-date="${ds}"]`);
    if (cellEl) startEditDOM(cellEl, pid, ds, getCellEntries(pid, ds).length ? 0 : -1);
    return;
  }

  // Tab 移动选区
  if (e.key === 'Tab') {
    e.preventDefault();
    if (!activeCell) {
      activeCell = sel ? { r: sel.r1, c: sel.c1 } : { r: 0, c: 0 };
    }
    moveActiveCell(0, e.shiftKey ? -1 : 1);
    return;
  }

  // Ctrl+A 全选
  if (isCtrl && e.key === 'a') {
    e.preventDefault();
    const total = allPeople().length;
    if (total === 0) return;
    sel = { r1: 0, c1: 0, r2: total - 1, c2: 6 };
    selAnchor = { r: 0, c: 0 };
    activeCell = { r: 0, c: 0 };
    syncPresenceActiveCell();
    renderEditTable();
    return;
  }
});

// ========================= 总览 =========================
// 返回某 (人,日期) 的所有小组块（无 conflict 概念，每个块 = 一个小组的排期）
// 返回数组：[{ groupId, groupName, note }, ...]，空数组表示无排班
function getScheduleInfo(personId, dateStr) {
  const ws = wsKey();
  const sched = data.schedules[ws] || {};
  const key = skey(personId, dateStr);
  const blocks = [];
  weekGroups().forEach(g => {
    const es = getEntries(g.id, personId, dateStr);
    es.forEach((e, idx) => {
      blocks.push({ groupId: g.id, groupName: g.name, note: e.note, idx });
    });
  });
  return blocks;
}

// 小组表中，当前单元格在其它小组是否已有排期（原“冲突”概念）
function getCrossGroupBlocks(personId, dateStr) {
  const blocks = [];
  weekGroups().forEach(g => {
    if (g.id === activeGroupId) return;
    const es = getEntries(g.id, personId, dateStr);
    es.forEach(e => blocks.push({ groupName: g.name, note: e.note }));
  });
  return blocks;
}

function renderOverview() {
  const ws = wsKey();
  const sched = data.schedules[ws] || {};
  const dates = weekDates(currentWeek);

  let total = 0;
  weekGroups().forEach(g => { if (sched[g.id]) total += Object.keys(sched[g.id]).length; });

  document.getElementById('statsRow').innerHTML = `
    <div class="stat"><div class="stat-val">${total}</div><div class="stat-label">总排班数</div></div>
    <div class="stat"><div class="stat-val">${allPeople().length}</div><div class="stat-label">总人数</div></div>
    <div class="stat"><div class="stat-val">${weekGroups().length}</div><div class="stat-label">小组</div></div>
    <div class="stat"><div class="stat-val">${Object.keys(sched).length}</div><div class="stat-label">有排班小组</div></div>
  `;

  // 历史周隐藏统计栏
  const scheduleMonday = fmtFull(getMonday(new Date(Date.now() + 7*86400000)));
  document.getElementById('statsRow').style.display = (ws < scheduleMonday) ? 'none' : '';

  const colorsRow = weekGroups().map((g,i) =>
    `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:11px;">
      <span style="width:8px;height:8px;border-radius:50%;background:${COLORS[i%COLORS.length]}"></span>${esc(g.name)}
    </span>`
  ).join('');
  document.getElementById('overviewColors').innerHTML = colorsRow;

  // 条件格式切换按钮
  const hasRules = data.conditionRules && data.conditionRules.length > 0;
  document.getElementById('overviewModeToggle').style.display = hasRules ? '' : 'none';
  // 有规则时自动启用条件着色
  if (hasRules && !ovConditionMode && !document.getElementById('ovModeBtn')._manualOff) {
    ovConditionMode = true;
  }
  document.getElementById('ovModeBtn').textContent = ovConditionMode ? '🏷 切换小组着色' : '🎨 切换条件着色';
  document.getElementById('ovModeBtn').className = 'btn' + (ovConditionMode ? ' btn-p' : '');

  let html = '<thead><tr><th>姓名</th>';
  dates.forEach((d,i) => html += calendarHeaderHTML(d, i));
  html += '</tr></thead><tbody>';

  // 总览提示（先清理旧的再插入）
  const oldHint = document.getElementById('ovHint');
  if (oldHint) oldHint.remove();
  const scheduleWeek = fmtFull(getMonday(new Date(Date.now() + 7*86400000)));
  const isScheduleWeek = wsKey() === scheduleWeek;
  document.getElementById('overviewPanel').insertAdjacentHTML('afterbegin',
    `<div class="hint-bar" id="ovHint" style="margin-bottom:12px;">
      ${isScheduleWeek ? '双击格子编辑内容 · 拖动小组块可移动到其他格 · 管理员点击格子右上角“休”设置全局休假 · 此表为最终导出源' : '双击格子录入/编辑内容 · 拖动小组块可移动到其他格 · 管理员点击格子右上角“休”设置全局休假'}
      <span class="hint-spacer"></span>
    </div>`);

  const ovPeople = weekPeople();
  if (ovPeople.length === 0) {
    html += '<tr><td colspan="8" style="padding:40px;color:var(--text2);text-align:center;">暂无人员</td></tr>';
  } else {
    let lastCat = null;
    ovPeople.forEach((p, r) => {
      if (p._cat !== lastCat) {
        const label = p._cat === 'internal' ? '内部人员' : '外协人员';
        html += `<tr class="section-row"><td colspan="8" style="padding:8px 16px;background:#f3f4f6;font-size:12px;font-weight:600;color:var(--text2);text-align:left;border-bottom:2px solid var(--border);">${label}</td></tr>`;
        lastCat = p._cat;
      }
      html += `<tr class="${p._cat === 'external' ? 'row-external' : ''}"><td>${personNameHTML(p)}<span class="row-del" onclick="event.stopPropagation();removePersonFromWeek('${p.id}')" title="从本周移除">×</span></td>`;
      dates.forEach((d, c) => {
        const ds = fmtFull(d);
        const blocks = getScheduleInfo(p.id, ds);
        const timeOff = getTimeOff(p.id, ds);
        const timeOffAction = (typeof isPermissionAdmin === 'function' && isPermissionAdmin())
          ? `<button class="timeoff-action${timeOff ? ' active' : ''}" title="${timeOff ? '编辑或取消全局休假' : '设置全局休假'}" onmousedown="event.stopPropagation()" onclick="event.stopPropagation();openTimeOffModal('${p.id}','${ds}')">休</button>`
          : '';
        if (blocks.length === 0) {
          // 空单元格：双击可在第一个小组新增（仅作便捷入口，主入口仍在各小组表）
          const defaultGid = weekGroups().length > 0 ? weekGroups()[0].id : '';
          html += `<td><div class="cell${timeOff ? ' has-timeoff' : ' cell-empty'} ov-cell" data-r="${r}" data-c="${c}" data-pid="${p.id}" data-date="${ds}" data-gid="${defaultGid}">${timeOffAction}${timeOff ? timeOffChipHTML(timeOff) : '-'}</div></td>`;
        } else {
          html += `<td><div class="cell ov-cell${timeOff ? ' has-timeoff timeoff-conflict-cell' : ''}" data-r="${r}" data-c="${c}" data-pid="${p.id}" data-date="${ds}">${timeOffAction}${timeOff ? timeOffChipHTML(timeOff) : ''}`;
          blocks.forEach(b => {
            const gi = weekGroups().findIndex(g => g.id === b.groupId);
            const condColor = ovConditionMode ? getConditionColor(b.note) : null;
            const style = condColor
              ? `color:#222;background:${hexToRgba(condColor, 0.30)};font-weight:600;`
              : `color:${(weekGroups()[gi].color || COLORS[gi%COLORS.length])};background:${hexToRgba((weekGroups()[gi].color || COLORS[gi%COLORS.length]), 0.12)};border-left:3px solid ${(weekGroups()[gi].color || COLORS[gi%COLORS.length])};`;
            const noteAttr = esc(b.note).replace(/"/g, '&quot;');
            html += `<div class="ov-block" style="${style}"
              data-gid="${b.groupId}" data-idx="${b.idx}" data-pid="${p.id}" data-date="${ds}" data-note="${noteAttr}"
              title="双击编辑 · 拖动移到其他格">${esc(b.note).replace(/\n/g, '<br>')}</div>`;
          });
          html += `</div></td>`;
        }
      });
      html += '</tr>';
    });
  }
  // 底部添加人员按钮
  html += `<tr class="add-row" onclick="quickAddPerson('internal')">
    <td colspan="8" style="padding:4px;text-align:center;color:var(--text2);cursor:pointer;border:none;">
      <span class="add-hint">+ 添加内部人员</span>
    </td>
  </tr>`;
  html += `<tr class="add-row" onclick="quickAddPerson('external')">
    <td colspan="8" style="padding:4px;text-align:center;color:var(--text2);cursor:pointer;border:none;background:#fefce8;">
      <span class="add-hint">+ 添加外协人员</span>
    </td>
  </tr>`;
  html += '</tbody>';
  document.getElementById('overviewTable').innerHTML = html;
}

// 总览表编辑入口 —— 编辑某一小组的具体块（idx）；idx<0 表示新增块
function ovEntryEdit(cellEl, personId, dateStr, groupId, idx) {
  if (!requireScheduleWeekEdit()) return;
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
  const entries = getEntries(groupId, personId, dateStr);
  const oldVal = (idx >= 0 && entries[idx]) ? entries[idx].note : '';
  const isNew = !(idx >= 0 && entries[idx]);
  if (isNew && getTimeOff(personId, dateStr)) {
    toast('该人员当天已标记休假，请先取消休假再新增排班');
    return;
  }

  editing = { mode:'overview', personId, dateStr, groupId, idx, isNew, el:cellEl, oldVal };
  if (typeof presenceClearCell === 'function') presenceClearCell();
  cellEl.classList.add('editing');
  cellEl.innerHTML = `<textarea style="width:100%;min-height:56px;border:none;background:transparent;text-align:center;font-size:13px;font-weight:500;font-family:inherit;outline:none;color:var(--text);resize:none;overflow:hidden;word-break:break-word;white-space:pre-wrap;" placeholder="输入任务"></textarea>`;
  const ta = cellEl.querySelector('textarea');
  ta.value = oldVal;
  ta.focus();
  ta.selectionStart = ta.value.length;
  autoResizeTextarea(ta);
  ta.addEventListener('input', () => autoResizeTextarea(ta));

  function commit() {
    if (!editing) return;
    const cur = editing;
    const newVal = ta.value.trim();
    const curEntries = getEntries(cur.groupId, cur.personId, cur.dateStr);
    let next;
    if (cur.isNew) {
      if (!newVal) { editing = null; presenceStopEditing(); requestAnimationFrame(() => renderOverview()); return; }
      next = curEntries.concat([{ note: newVal }]);
    } else {
      if (cur.oldVal === newVal) { editing = null; presenceStopEditing(); requestAnimationFrame(() => renderOverview()); return; }
      next = curEntries.slice();
      if (newVal) next[cur.idx] = { note: newVal };
      else next.splice(cur.idx, 1);
    }
    setEntries(cur.groupId, cur.personId, cur.dateStr, next);
    pushUndo([{ personId: cur.personId, dateStr: cur.dateStr, groupId: cur.groupId, oldVal: curEntries, newVal: next }]);
    saveData();
    editing = null;
    presenceStopEditing();
    requestAnimationFrame(() => renderOverview());
  }

  ta.addEventListener('blur', () => {
    setTimeout(() => { if (editing) commit(); }, 100);
  });
  ta.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); editing = null; presenceStopEditing(); requestAnimationFrame(() => renderOverview()); }
  });
}

// ========================= 总览拖拽移动 =========================
let ovDrag = null;
let ovDragStarted = false;

// 直接在 cell data 上查源数据（不用 getCell，因为 overview 下 activeGroupId 不是具体组）
function getGroupCell(groupId, personId, dateStr) {
  return getEntries(groupId, personId, dateStr);
}

function setGroupCell(groupId, personId, dateStr, val) {
  if (Array.isArray(val)) { setEntries(groupId, personId, dateStr, val); return; }
  setEntries(groupId, personId, dateStr, val ? [{ note: val }] : []);
}

function cleanupOvDrag() {
  if (ovDrag && ovDrag.sourceEl) {
    ovDrag.sourceEl.style.opacity = '';
    ovDrag.sourceEl.style.border = '';
    ovDrag.sourceEl.style.cursor = '';
  }
  document.querySelectorAll('#overviewTable .drag-target').forEach(el => {
    el.classList.remove('drag-target'); el.style.background = ''; el.style.border = '';
  });
  ovDrag = null;
  ovDragStarted = false;
}

// ========================= 总览单块拖动 =========================
// 拖动一个小组块到别处：源位置移除该块，目标位置叠加该块（空/非空都直接加，不再弹窗、无交换/加入概念）
// 即使目标已存在同一小组的块，也作为「另一个独立块」追加，不会覆盖。
function moveBlock(groupId, srcPid, srcDate, srcIdx, tPid, tDate) {
  if (!requireScheduleWeekEdit()) return;
  if (getTimeOff(tPid, tDate)) { toast('目标人员当天已休假，不能移入排班'); return; }
  if (srcPid === tPid && srcDate === tDate) return; // 同一格不处理
  const srcEntries = getEntries(groupId, srcPid, srcDate);
  if (srcIdx < 0 || srcIdx >= srcEntries.length) return;
  const moved = srcEntries[srcIdx];
  if (!moved || !moved.note) return;
  const tgtEntries = getEntries(groupId, tPid, tDate);

  const changes = [];
  // 目标：追加新块
  const newTgt = tgtEntries.concat([{ note: moved.note }]);
  setEntries(groupId, tPid, tDate, newTgt);
  changes.push({ personId: tPid, dateStr: tDate, groupId, oldVal: tgtEntries, newVal: newTgt });
  // 源：移除被拖走的块
  const newSrc = srcEntries.filter((_, i) => i !== srcIdx);
  setEntries(groupId, srcPid, srcDate, newSrc);
  changes.push({ personId: srcPid, dateStr: srcDate, groupId, oldVal: srcEntries, newVal: newSrc });

  pushUndo(changes, { type:'move', groupId, content: (moved && moved.note) || '', fromPerson: srcPid, fromDate: srcDate, toPerson: tPid, toDate: tDate });
  saveData();
}

// 总览空白格：先选小组再录入，保证归属正确（避免默认落到第一个组）
let ovPickCell = null;
function ovPickGroupForNew(pid, ds, cellEl) {
  closeOvGroupPick();
  const groups = weekGroups();
  if (!groups.length) { ovEntryEdit(cellEl, pid, ds, '', -1); return; }
  ovPickCell = cellEl;
  const rect = cellEl.getBoundingClientRect();
  const pick = document.createElement('div');
  pick.id = 'ovGroupPick';
  pick.style.cssText = 'position:absolute;z-index:800;background:var(--bg);border:1.5px solid var(--border);border-radius:12px;padding:8px;box-shadow:0 10px 30px rgba(0,0,0,.2);min-width:170px;';
  pick.innerHTML = `<div style="font-size:12px;color:var(--text2);margin:2px 4px 8px;">选择要加入的小组</div>` +
    groups.map((g, i) => `<button class="btn" style="display:block;width:100%;margin:3px 0;text-align:left;color:${(g.color || COLORS[i % COLORS.length])};font-weight:600;" onclick="ovGroupPickChoose('${pid}','${ds}','${g.id}')">${esc(g.name)}</button>`).join('');
  pick.style.left = (window.scrollX + rect.left) + 'px';
  pick.style.top = (window.scrollY + rect.bottom + 4) + 'px';
  document.body.appendChild(pick);
  setTimeout(() => document.addEventListener('mousedown', ovGroupPickOutside, { once: true }), 0);
}
function ovGroupPickChoose(pid, ds, gid) {
  const cell = ovPickCell;
  closeOvGroupPick();
  if (cell) ovEntryEdit(cell, pid, ds, gid, -1);
}
function ovGroupPickOutside(e) {
  if (!e.target.closest('#ovGroupPick')) closeOvGroupPick();
}
function closeOvGroupPick() {
  const p = document.getElementById('ovGroupPick');
  if (p) p.remove();
  ovPickCell = null;
}
