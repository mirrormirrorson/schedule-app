// ========================= 管理弹窗 =========================
let manageActiveTab = 'people';
const PERSON_RADAR_ADMINS = new Set(['张雅镜', '林俊凯']);

function canManagePersonRadar() {
  return PERSON_RADAR_ADMINS.has(String(userName() || '').trim());
}

function requireRadarPermission() {
  if (canManagePersonRadar()) return true;
  alert('暂无权限，请联系林俊凯修改');
  return false;
}

function openManageModal() {
  document.getElementById('manageModal').style.display = 'flex';
  switchManageTab('people');
}

function closeManageModal() {
  document.getElementById('manageModal').style.display = 'none';
  renderAll();
}

function switchManageTab(tab) {
  manageActiveTab = tab;
  document.querySelectorAll('.mtab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.mtab[onclick="switchManageTab('${tab}')"]`).classList.add('active');
  document.querySelectorAll('.manage-panel').forEach(p => p.style.display = 'none');
  document.getElementById('panel' + tab.charAt(0).toUpperCase() + tab.slice(1)).style.display = '';
  const hint = tab === 'people' ? '人员列表下方可维护全员共用的雷达字段；排班表姓名悬停即可查看。' :
    tab === 'groups' ? '编辑排班小组。' :
    tab === 'conditions' ? '用关键词和颜色快速标记重要排班内容。' : '选择配色主题与字体样式。';
  const hintEl = document.getElementById('manageHint');
  hintEl.textContent = hint;
  hintEl.style.display = hint ? '' : 'none';
  renderManageTab();
}

// 主题定义
const THEMES = [
  { id:'pink', name:'柔和粉', colors:['#ff6b9d','#f8c8d8','#fff0f5','#fff'] },
  { id:'blue', name:'蓝白专业', colors:['#2563eb','#60a5fa','#dbeafe','#eaf2ff'] },
  { id:'dark', name:'科技深空', colors:['#38bdf8','#6366f1','#0b1120','#070b16'] },
  { id:'mint', name:'薄荷清新', colors:['#10b981','#a7f3d0','#ecfdf5','#fff'] },
];
// 字体选项
const FONTS = [
  { id:'system', name:'系统默认', css:'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif', preview:'Aa 排班汇总表', weight:400 },
  { id:'bold', name:'粗体雅黑', css:'"PingFang SC", "Microsoft YaHei", system-ui, sans-serif', preview:'Aa 排班汇总表', weight:700 },
  { id:'song', name:'宋体衬线', css:'"Songti SC", "SimSun", "Noto Serif CJK SC", serif', preview:'Aa 排班汇总表', weight:400 },
  { id:'kai', name:'楷体系列', css:'"Kaiti SC", "KaiTi", "STKaiti", serif', preview:'Aa 排班汇总表', weight:400 },
];
let currentTheme = localStorage.getItem('schedule_theme') || 'pink';
let currentFont = localStorage.getItem('schedule_font') || 'system';

function applyTheme(id) {
  currentTheme = id;
  document.documentElement.setAttribute('data-theme', id);
  localStorage.setItem('schedule_theme', id);
}

function applyFont(id) {
  currentFont = id;
  const font = FONTS.find(f => f.id === id);
  if (font) {
    document.documentElement.style.setProperty('--font', font.css);
    localStorage.setItem('schedule_font', id);
  }
  renderThemeTab();
}
// 初始化字体
(function() {
  const f = FONTS.find(f => f.id === currentFont) || FONTS[0];
  document.documentElement.style.setProperty('--font', f.css);
})();
// 初始化主题
document.documentElement.setAttribute('data-theme', currentTheme);

function renderThemeTab() {
  let html = '';

  html += '<p style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px;">主题</p>';
  html += '<div style="display:flex;gap:8px;margin-bottom:20px;">';
  html += THEMES.map(t => `
    <div onclick="applyTheme('${t.id}');renderThemeTab()" style="
      cursor:pointer; border-radius:8px; padding:10px 16px; border:2px solid ${t.id===currentTheme?'var(--primary)':'var(--border)'};
      background:${t.id===currentTheme?'var(--cell-hover-bg)':'var(--card)'};
      display:flex;align-items:center;gap:8px;flex:1;
    ">
      <div style="display:flex;gap:3px;">
        ${t.colors.map(c=>`<span style="width:14px;height:14px;border-radius:3px;background:${c};"></span>`).join('')}
      </div>
      <span style="font-size:13px;font-weight:600;color:var(--text);">${t.name}</span>
    </div>
  `).join('');
  html += '</div>';

  html += '<p style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px;">字体</p>';
  html += '<div style="display:flex;gap:8px;">';
  html += FONTS.map(f => `
    <div onclick="applyFont('${f.id}')" style="
      cursor:pointer; border-radius:8px; padding:10px 16px; border:2px solid ${f.id===currentFont?'var(--primary)':'var(--border)'};
      background:${f.id===currentFont?'var(--cell-hover-bg)':'var(--card)'};
      text-align:center;flex:1;
    ">
      <div style="font-size:16px;font-weight:${f.weight};color:var(--text);font-family:${f.css};">${f.preview}</div>
      <div style="font-size:11px;color:var(--text2);margin-top:2px;">${f.name}</div>
    </div>
  `).join('');
  html += '</div>';

  document.getElementById('themeOptions').innerHTML = html;
}

function managePersonHTML(person, color) {
  const fields = getRadarFields();
  const scores = getPersonRadarScores(person.id);
  const scored = fields.filter(field => Object.prototype.hasOwnProperty.call(scores, field.id)).length;
  const average = scored
    ? (fields.reduce((sum, field) => sum + normalizeRadarScore(scores[field.id]), 0) / fields.length).toFixed(1)
    : '';
  const summary = fields.length < 3
    ? '请先设置至少 3 个雷达字段'
    : scored ? `已评分 ${scored}/${fields.length} 项 · 平均 ${average} 分` : '待设置个人分数';
  return `<div class="manage-item">
    <span class="manage-item-color" style="background:${color}"></span>
    <span class="manage-person-main">
      <span class="manage-item-name">${esc(person.name)}</span>
      <span class="manage-person-radar-summary${scored ? '' : ' empty'}">${summary}</span>
    </span>
    <span class="manage-item-actions">
      <button class="manage-icon-btn" onclick="editPersonRadar('${person.id}')" title="设置雷达分数" aria-label="设置 ${esc(person.name)} 的雷达分数">◈</button>
      <button class="manage-icon-btn" onclick="renamePerson('${person.id}')" title="修改姓名" aria-label="修改 ${esc(person.name)}">✎</button>
      <button class="manage-icon-btn danger" onclick="removePerson('${person.id}')" title="删除人员" aria-label="删除 ${esc(person.name)}">×</button>
    </span>
  </div>`;
}

function manageGroupHTML(group, index) {
  const color = group.color || COLORS[index % COLORS.length];
  return `<div class="manage-item">
    <span class="manage-item-color" style="background:${color}"></span>
    <span class="manage-item-name">${esc(group.name)}</span>
    <span class="manage-item-actions">
      <button class="manage-icon-btn" onclick="renameGroup('${group.id}')" title="修改小组名" aria-label="修改 ${esc(group.name)}">✎</button>
      <button class="manage-icon-btn danger" onclick="removeGroup('${group.id}')" title="删除小组" aria-label="删除 ${esc(group.name)}">×</button>
    </span>
  </div>`;
}

function renderManageTab() {
  if (manageActiveTab === 'people') {
    renderRadarFieldSettings();
    document.getElementById('internalPeopleCount').textContent = `${data.internalPeople.length} 人`;
    document.getElementById('externalPeopleCount').textContent = `${data.externalPeople.length} 人`;
    document.getElementById('manageInternalTags').innerHTML = data.internalPeople
      .map((person, index) => managePersonHTML(person, COLORS[index % COLORS.length]))
      .join('') || '<div class="manage-empty">暂无内部人员</div>';

    document.getElementById('manageExternalTags').innerHTML = data.externalPeople
      .map((person, index) => managePersonHTML(person, COLORS[(index + data.internalPeople.length) % COLORS.length]))
      .join('') || '<div class="manage-empty">暂无外协人员</div>';
  } else if (manageActiveTab === 'groups') {
    document.getElementById('groupCount').textContent = `${data.groups.length} 组`;
    document.getElementById('manageGroupTags').innerHTML = data.groups
      .map(manageGroupHTML)
      .join('') || '<div class="manage-empty">暂无小组</div>';
  } else if (manageActiveTab === 'conditions') {
    renderConditionPalette();
    document.getElementById('conditionRuleCount').textContent = `${(data.conditionRules || []).length} 条`;
    document.getElementById('conditionRulesList').innerHTML = (data.conditionRules || []).map(condRuleHTML).join('') || '<span class="cond-empty" style="font-size:12px;color:var(--text2);">暂无规则，上方添加</span>';
    delete document.getElementById('conditionRulesList').dataset.editing;
  } else if (manageActiveTab === 'theme') {
    renderThemeTab();
  }
}

function renderRadarFieldSettings() {
  const fields = getRadarFields();
  const canEdit = canManagePersonRadar();
  document.getElementById('radarFieldCount').textContent = `${fields.length} 项`;
  const addInput = document.getElementById('newRadarFieldInput');
  addInput.readOnly = !canEdit;
  addInput.setAttribute('aria-disabled', canEdit ? 'false' : 'true');
  document.getElementById('radarFieldList').innerHTML = fields.length
    ? fields.map((field, index) => `<div class="radar-field-item">
        <span class="radar-field-index">${index + 1}</span>
        <input type="text" maxlength="12" value="${esc(field.name)}" aria-label="雷达字段 ${index + 1}" ${canEdit ? '' : 'readonly aria-disabled="true"'} onclick="if(!canManagePersonRadar())requireRadarPermission()" onchange="updateRadarField('${field.id}',this.value)">
        <button class="manage-icon-btn danger" onclick="removeRadarField('${field.id}')" title="删除字段" aria-label="删除 ${esc(field.name)}">×</button>
      </div>`).join('')
    : '<div class="manage-empty radar-field-empty">暂无字段，请至少添加 3 个字段</div>';
}

function addRadarField() {
  if (!requireRadarPermission()) return;
  const input = document.getElementById('newRadarFieldInput');
  const name = String(input.value || '').trim();
  const fields = getRadarFields();
  if (!name) return;
  if (fields.length >= 8) { alert('雷达图最多设置 8 个字段'); return; }
  if (fields.some(field => field.name === name)) { alert('字段名称已存在'); return; }
  if (!Array.isArray(data.personRadarFields)) data.personRadarFields = [];
  data.personRadarFields.push({ id: `rf${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name: name.slice(0, 12) });
  input.value = '';
  saveData();
  renderManageTab();
  renderAll();
}

function updateRadarField(id, value) {
  if (!requireRadarPermission()) { renderManageTab(); return; }
  const fields = getRadarFields();
  const field = fields.find(item => item.id === id);
  const name = String(value || '').trim().slice(0, 12);
  if (!field) return;
  if (!name) { alert('字段名称不能为空'); renderManageTab(); return; }
  if (fields.some(item => item.id !== id && item.name === name)) {
    alert('字段名称已存在'); renderManageTab(); return;
  }
  if (field.name === name) return;
  field.name = name;
  saveData();
  renderManageTab();
  renderAll();
}

function removeRadarField(id) {
  if (!requireRadarPermission()) return;
  const fields = getRadarFields();
  const field = fields.find(item => item.id === id);
  if (!field || !confirm(`确定删除雷达字段「${field.name}」？\n所有人员在该字段上的分数会一并移除。`)) return;
  data.personRadarFields = fields.filter(item => item.id !== id);
  if (data.personRadarScores && typeof data.personRadarScores === 'object') {
    Object.values(data.personRadarScores).forEach(scores => {
      if (scores && typeof scores === 'object') delete scores[id];
    });
  }
  saveData();
  renderManageTab();
  renderAll();
}

function editPersonRadar(id) {
  if (!requireRadarPermission()) return;
  const person = data.internalPeople.find(item => item.id === id)
    || data.externalPeople.find(item => item.id === id);
  const fields = getRadarFields();
  if (!person) return;
  if (fields.length < 3) { alert('请先设置至少 3 个雷达字段'); return; }

  const old = document.getElementById('personRadarModal');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'personRadarModal';
  overlay.className = 'modal-overlay person-radar-overlay';
  const current = getPersonRadarScores(id);
  overlay.innerHTML = `<div class="modal person-radar-modal">
    <div class="person-radar-modal-head">
      <div><h3>${esc(person.name)} · 任务雷达评分</h3><p>所有字段满分 10 分，本次只修改该人员的分数</p></div>
      <button class="btn manage-close" id="personRadarClose" aria-label="关闭雷达评分">✕</button>
    </div>
    <div class="person-radar-editor">
      <div class="person-radar-preview" id="personRadarPreview"></div>
      <div class="person-radar-score-list">
        ${fields.map(field => `<label class="person-radar-score-row">
          <span>${esc(field.name)}</span>
          <input type="number" min="0" max="10" step="1" inputmode="numeric" data-radar-field="${field.id}" value="${normalizeRadarScore(current[field.id])}">
          <small>/ 10</small>
        </label>`).join('')}
      </div>
    </div>
    <div class="person-radar-modal-foot">
      <button class="btn danger-text" id="personRadarClear">清空该人员评分</button>
      <div><button class="btn" id="personRadarCancel">取消</button><button class="btn btn-p" id="personRadarSave">保存评分</button></div>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const inputs = [...overlay.querySelectorAll('[data-radar-field]')];
  const collect = () => Object.fromEntries(inputs.map(input => [input.dataset.radarField, normalizeRadarScore(input.value)]));
  const updatePreview = () => {
    overlay.querySelector('#personRadarPreview').innerHTML = buildPersonRadarSVG(fields, collect(), { width: 320, height: 260 });
  };
  inputs.forEach(input => input.addEventListener('input', () => {
    const score = normalizeRadarScore(input.value);
    if (String(score) !== input.value && input.value !== '') input.value = score;
    updatePreview();
  }));
  const close = () => overlay.remove();
  overlay.querySelector('#personRadarClose').addEventListener('click', close);
  overlay.querySelector('#personRadarCancel').addEventListener('click', close);
  overlay.querySelector('#personRadarSave').addEventListener('click', () => {
    if (!data.personRadarScores || typeof data.personRadarScores !== 'object') data.personRadarScores = {};
    data.personRadarScores[id] = collect();
    close();
    saveData();
    renderManageTab();
    renderAll();
    toast('雷达评分已保存');
  });
  overlay.querySelector('#personRadarClear').addEventListener('click', () => {
    if (!confirm(`确定清空「${person.name}」的全部雷达分数？`)) return;
    if (data.personRadarScores) delete data.personRadarScores[id];
    close();
    saveData();
    renderManageTab();
    renderAll();
    toast('雷达评分已清空');
  });
  overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
  overlay.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  updatePreview();
}

function addPerson(cat, name) {
  const list = cat === 'internal' ? data.internalPeople : data.externalPeople;
  name = (name || '').trim();
  if (!name) return;
  if (list.find(p => p.name === name) || data[cat === 'internal' ? 'externalPeople' : 'internalPeople'].find(p => p.name === name)) {
    alert('已存在'); return;
  }
  const prefix = cat === 'internal' ? 'p' : 'e';
  list.push({ id: prefix + Date.now(), name });
  logPersonAction('addPerson', name, 'template', { category: cat });
  saveData();
  renderManageTab();
}

function addPersonFromInput(cat) {
  const inpId = cat === 'internal' ? 'newInternalInput' : 'newExternalInput';
  const inp = document.getElementById(inpId);
  addPerson(cat, inp.value);
  inp.value = '';
}

function renamePerson(id) {
  // 管理界面只操作常用模板（internal/external），避免 findPersonList 优先命中本周快照
  let p = data.internalPeople.find(x => x.id === id);
  let listName = 'internal';
  if (!p) {
    p = data.externalPeople.find(x => x.id === id);
    listName = 'external';
  }
  if (!p) return;
  showNameInputModal('修改姓名', p.name, val => {
    const name = (val || '').trim();
    if (!name || name === p.name) return;
    // 检查另一侧模板中的重名（同一列表内的重名通过 id 自排除）
    const otherList = listName === 'internal' ? data.externalPeople : data.internalPeople;
    if (otherList.find(x => x.name === name)) { alert('已存在'); return; }
    const oldName = p.name;
    p.name = name;
    renamePersonInAllWeeks(id, name);
    logPersonAction('renamePerson', oldName + ' → ' + name, 'template', {
      category: listName,
      detail: { old: oldName, new: name }
    });
    saveData(); renderManageTab(); renderAll();
  });
}

function removePerson(id) {
  if (!confirm('确定从常用模板及所有周人员列表中删除该人员？\n排班数据仍保留，但表格中不再显示。')) return;
  let idx = data.internalPeople.findIndex(p => p.id === id);
  let list = null;
  if (idx >= 0) {
    list = data.internalPeople;
  } else {
    idx = data.externalPeople.findIndex(p => p.id === id);
    if (idx >= 0) list = data.externalPeople;
  }
  if (!list) return;
  const personName = (list[idx] && list[idx].name) || '未知';
  list.splice(idx, 1);
  if (data.personRadarScores) delete data.personRadarScores[id];
  removePersonFromAllWeeks(id);
  logPersonAction('removePerson', personName, 'template', {
    category: list === data.internalPeople ? 'internal' : 'external'
  });
  clearSelection();
  saveData(); renderManageTab(); renderAll();
}

// 同步改名到所有周的人员快照
function renamePersonInAllWeeks(id, newName) {
  if (!data.weekPeople) return;
  for (const arr of Object.values(data.weekPeople)) {
    const p = arr.find(x => x.id === id);
    if (p) p.name = newName;
  }
}

// 从所有周的人员快照中移除
function removePersonFromAllWeeks(id) {
  if (!data.weekPeople) return;
  for (const ws of Object.keys(data.weekPeople)) {
    const arr = data.weekPeople[ws];
    const idx = arr.findIndex(x => x.id === id);
    if (idx >= 0) arr.splice(idx, 1);
  }
}
function ensureGroupColors(persist = true) {
  const before = JSON.stringify({
    groups: data.groups,
    weekGroups: data.weekGroups,
    weekGroupLocked: data.weekGroupLocked
  });
  const wg = weekGroups();
  const used = new Set();
  wg.forEach(g => { if (g.color && COLORS.includes(g.color)) used.add(g.color); });
  wg.forEach(g => {
    if (!g.color || !COLORS.includes(g.color)) {
      const c = COLORS.find(x => !used.has(x));
      g.color = c || COLORS[used.size % COLORS.length];
      if (c) used.add(c);
    }
  });
  (data.groups || []).forEach(dg => {
    const w = wg.find(x => x.id === dg.id);
    if (w && w.color) dg.color = w.color;
  });
  lockWeekGroups(false);
  const changed = before !== JSON.stringify({
    groups: data.groups,
    weekGroups: data.weekGroups,
    weekGroupLocked: data.weekGroupLocked
  });
  if (changed && persist) saveData();
  return changed;
}

function addGroup() {
  const inp = document.getElementById('newGroupInput');
  const name = inp.value.trim();
  if (!name) return;
  if (data.groups.find(g => g.name===name)) { alert('已存在'); return; }
  const g = { id:'g'+Date.now(), name };
  data.groups.push(g); inp.value = '';
  // 同步到当前周的小组
  const wg = weekGroups();
  if (!wg.find(x => x.id === g.id)) wg.push({ id: g.id, name: g.name });
  lockWeekGroups(false);
  ensureGroupColors(false);
  saveData(); renderManageTab(); renderAll();
}

// 多行文本输入弹窗（支持换行），用于添加人员姓名
function showNameInputModal(title, defaultVal, onConfirm) {
  const old = document.getElementById('nameInputModal');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'nameInputModal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.4);display:flex;align-items:center;justify-content:center;z-index:600;';
  overlay.innerHTML = `
    <div style="background:var(--card);border-radius:14px;padding:20px 22px;width:360px;max-width:92vw;box-shadow:0 12px 40px rgba(0,0,0,.18);border:1.5px solid var(--border);">
      <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:var(--text);">${title}</div>
      <textarea id="nameInputArea" placeholder="按Enter换行" style="width:100%;min-height:96px;resize:vertical;border:1.5px solid var(--border);border-radius:10px;padding:10px;font-size:14px;font-family:inherit;color:var(--text);box-sizing:border-box;white-space:pre-wrap;word-break:break-word;"></textarea>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">
        <button class="btn" onclick="document.getElementById('nameInputModal').remove()">取消</button>
        <button class="btn btn-p" id="nameInputConfirm">确定</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const ta = overlay.querySelector('#nameInputArea');
  ta.value = defaultVal || '';
  ta.focus();
  const doConfirm = () => { const v = ta.value; overlay.remove(); onConfirm(v); };
  overlay.querySelector('#nameInputConfirm').addEventListener('click', doConfirm);
  ta.addEventListener('keydown', e => {
    // 阻止事件冒泡，避免触发表格全局快捷键（如 Ctrl+A / Enter 等）
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doConfirm(); }
    if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
  });
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
}

// 快速添加人员（表格底部+号）
function quickAddPerson(cat) {
  const label = cat === 'internal' ? '内部' : '外协';
  showNameInputModal(`添加${label}人员姓名（仅本周）`, '', val => {
    if (!val || !val.trim()) return;
    // 整体作为一个人员（多行作为该人员姓名的一部分），不在管理里增删
    if (weekPeople().find(p => p.name === val.trim())) { alert('本周已存在'); return; }
    const prefix = cat === 'internal' ? 'p' : 'e';
    const newPerson = { id: prefix + Date.now(), name: val.trim(), _cat: cat };
    weekPeople().push(newPerson);
    lockWeekPeople();
    logPersonAction('addPerson', val.trim(), 'week', { category: cat });
    saveData();
    renderAll();
  });
}
function removePersonFromWeek(personId) {
  const wp = weekPeople();
  const idx = wp.findIndex(p => p.id === personId);
  if (idx < 0) return;
  const person = wp[idx];
  if (!confirm(`确定从本周删除「${person.name}」？\n其他周和常用模板不受影响。`)) return;
  wp.splice(idx, 1);
  lockWeekPeople();
  logPersonAction('removeFromWeek', person.name, 'week', { category: person._cat || '' });
  saveData();
  renderAll();
}
function renameGroup(id) {
  const g = data.groups.find(x => x.id===id);
  if (!g) return;
  const n = prompt('修改小组名：', g.name);
  if (!n||!n.trim()||n.trim()===g.name) return;
  if (data.groups.find(x => x.name===n.trim())) { alert('已存在'); return; }
  g.name = n.trim(); saveData(); renderManageTab();
}
function removeGroup(id) {
  if (!confirm('确定从模板中删除该小组？\n已有各周的排班数据不受影响。')) return;
  data.groups = data.groups.filter(g => g.id !== id);
  if (activeGroupId === id) activeGroupId = weekGroups()[0] ? weekGroups()[0].id : null;
  saveData(); renderManageTab(); renderAll();
}

function addConditionRule() {
  const inp = document.getElementById('newCondText');
  const text = inp.value.trim();
  if (!text) return;
  if (!data.conditionRules) data.conditionRules = [];
  if (data.conditionRules.find(r => r.text === text)) { alert('已存在'); return; }
  const color = selectedCondColor || '#ef4444';
  const rule = { id: 'cr' + Date.now(), text, color };
  data.conditionRules.push(rule);
  inp.value = '';
  saveData();
  // 延迟DOM操作，确保IME事件已完成
  setTimeout(() => {
    const el = document.getElementById('conditionRulesList');
    if (el.querySelector('.cond-empty')) el.innerHTML = '';
    el.insertAdjacentHTML('beforeend', condRuleHTML(rule));
    el.scrollTop = el.scrollHeight;
    document.getElementById('conditionRuleCount').textContent = `${data.conditionRules.length} 条`;
    inp.focus();
  }, 0);
}

function pickCondColor(el, color) {
  selectedCondColor = color;
  document.querySelectorAll('#presetColors .condition-color').forEach(button => {
    button.classList.toggle('active', button.dataset.color === color);
  });
  updateSelectedCondColorUI();
}

// ========================= 颜色系列 =========================
const COLOR_SERIES = {
  highlight: {
    name: '重点鲜明',
    colors: ['#ef4444','#f43f5e','#ec4899','#d946ef','#a855f7','#8b5cf6','#6366f1','#3b82f6','#0ea5e9','#06b6d4','#14b8a6','#10b981','#22c55e','#84cc16','#eab308','#f59e0b','#f97316','#fb7185'],
  },
  soft: {
    name: '柔和浅色',
    colors: ['#fecdd3','#fbcfe8','#f5d0fe','#e9d5ff','#ddd6fe','#c7d2fe','#bfdbfe','#bae6fd','#a5f3fc','#99f6e4','#a7f3d0','#bbf7d0','#d9f99d','#fef08a','#fde68a','#fed7aa','#fecaca','#e2e8f0'],
  },
  cool: {
    name: '冷静蓝绿',
    colors: ['#1d4ed8','#2563eb','#0284c7','#0891b2','#0e7490','#0f766e','#059669','#047857','#60a5fa','#38bdf8','#22d3ee','#2dd4bf','#34d399','#6ee7b7','#93c5fd','#67e8f9','#5eead4','#a7f3d0'],
  },
  warm: {
    name: '暖色能量',
    colors: ['#b91c1c','#dc2626','#e11d48','#ea580c','#f97316','#d97706','#f59e0b','#ca8a04','#facc15','#fb7185','#fda4af','#fdba74','#fed7aa','#fcd34d','#fde68a','#be123c','#c2410c','#a16207'],
  },
  muted: {
    name: '低饱和',
    colors: ['#c9a5a0','#b8a89a','#a3b5a6','#a8bfc2','#b4a7c4','#d4b8c7','#c2b5a7','#b5b8c2','#a8c4c2','#d1c4b8','#c8b8d0','#b0c4b8','#c4a8b0','#bcc4c0','#d8c8c0','#c0b8c8','#94a3b8','#a8a29e'],
  },
  deep: {
    name: '深色对比',
    colors: ['#7f1d1d','#881337','#701a75','#581c87','#4c1d95','#312e81','#1e3a8a','#0c4a6e','#164e63','#134e4a','#14532d','#365314','#713f12','#78350f','#7c2d12','#334155','#3f3f46','#1f2937'],
  },
};
let currentColorSeries = 'highlight';
let selectedCondColor = '#ef4444';

function switchPresetSeries(k) {
  currentColorSeries = k;
  renderConditionPalette();
}

function updateSelectedCondColorUI() {
  const swatch = document.getElementById('selectedCondSwatch');
  const hex = document.getElementById('selectedCondHex');
  const custom = document.getElementById('customCondColor');
  if (swatch) swatch.style.background = selectedCondColor;
  if (hex) hex.textContent = selectedCondColor.toUpperCase();
  if (custom) custom.value = selectedCondColor;
}

function renderConditionPalette() {
  const tabs = document.getElementById('colorSeriesBtns');
  const grid = document.getElementById('presetColors');
  if (!tabs || !grid) return;
  tabs.innerHTML = Object.entries(COLOR_SERIES).map(([key, series]) =>
    `<button class="${key === currentColorSeries ? 'active' : ''}"
      onclick="switchPresetSeries('${key}')">${series.name}</button>`
  ).join('');
  grid.innerHTML = COLOR_SERIES[currentColorSeries].colors.map(color =>
    `<button class="condition-color${color === selectedCondColor ? ' active' : ''}"
      style="--swatch:${color}" data-color="${color}" title="${color.toUpperCase()}"
      aria-label="选择颜色 ${color}" onclick="pickCondColor(this,'${color}')"></button>`
  ).join('');
  updateSelectedCondColorUI();
}

function setCustomCondColor(color) {
  selectedCondColor = color;
  document.querySelectorAll('#presetColors .condition-color').forEach(button => button.classList.remove('active'));
  updateSelectedCondColorUI();
}

function condRuleHTML(r) {
  return `<div class="cond-rule" id="condRule_${r.id}">
    <button class="cond-rule-color" style="--rule-color:${r.color}" onclick="startEditCondition('${r.id}')"
      title="修改颜色" aria-label="修改规则颜色"></button>
    <span class="cond-text" onclick="startEditCondition('${r.id}')">包含「${esc(r.text)}」</span>
    <span class="cond-act" onclick="startEditCondition('${r.id}')" title="编辑">✎</span>
    <span class="cond-act del" onclick="removeConditionRule('${r.id}')" title="删除">×</span>
  </div>`;
}

function removeConditionRule(id) {
  data.conditionRules = data.conditionRules.filter(r => r.id !== id);
  saveData();
  const el = document.getElementById('condRule_' + id);
  if (el) {
    el.remove();
    document.getElementById('conditionRuleCount').textContent = `${data.conditionRules.length} 条`;
    if (data.conditionRules.length === 0) document.getElementById('conditionRulesList').innerHTML = '<span class="cond-empty" style="font-size:12px;color:var(--text2);">暂无规则，上方添加</span>';
  }
}

function startEditCondition(id) {
  const rule = data.conditionRules.find(r => r.id === id);
  if (!rule) return;
  const el = document.getElementById('condRule_' + id);
  if (!el) return;
  document.getElementById('conditionRulesList').dataset.editing = id;
  const editColors = COLOR_SERIES[currentColorSeries].colors.slice(0, 18);
  el.outerHTML = `<div class="cond-rule cond-rule-editing" id="condRule_${id}">
    <div class="cond-edit-main">
      <input type="text" id="condEditText_${id}" value="${esc(rule.text)}"
      onkeydown="if(event.key==='Enter' && !event.isComposing)saveEditCondition('${id}');if(event.key==='Escape')renderManageTab()">
      <label class="cond-edit-custom" title="自定义颜色">
        <input type="color" value="${rule.color}" onchange="pickEditColorValue(this.value,'${id}',this)">
        <span style="background:${rule.color}"></span>
      </label>
      <button class="manage-icon-btn" onclick="saveEditCondition('${id}')" title="保存">✓</button>
      <button class="manage-icon-btn danger" onclick="renderManageTab()" title="取消">×</button>
    </div>
    <div class="cond-edit-colors">
      ${editColors.map(color => `<button class="${color === rule.color ? 'active' : ''}"
        style="--swatch:${color}" onclick="pickEditColor(this,'${color}','${id}')" data-color="${color}"
        title="${color.toUpperCase()}" aria-label="选择颜色 ${color}"></button>`).join('')}
    </div>
  </div>`;
  const inp = document.getElementById('condEditText_' + id);
  inp.focus(); inp.select();
}

function pickEditColor(el, color, id) {
  const rule = data.conditionRules.find(r => r.id === id);
  if (!rule) return;
  rule.color = color;
  saveData();
  const parent = el.closest('.cond-rule');
  if (parent) {
    parent.querySelectorAll('.cond-edit-colors button').forEach(button => {
      button.classList.toggle('active', button.dataset.color === color);
    });
    const customPreview = parent.querySelector('.cond-edit-custom span');
    const customInput = parent.querySelector('.cond-edit-custom input');
    if (customPreview) customPreview.style.background = color;
    if (customInput) customInput.value = color;
  }
}

function pickEditColorValue(color, id, input) {
  const rule = data.conditionRules.find(r => r.id === id);
  if (!rule) return;
  rule.color = color;
  saveData();
  const parent = input.closest('.cond-rule');
  if (parent) {
    parent.querySelectorAll('.cond-edit-colors button').forEach(button => button.classList.remove('active'));
    const preview = parent.querySelector('.cond-edit-custom span');
    if (preview) preview.style.background = color;
  }
}

function saveEditCondition(id) {
  const inp = document.getElementById('condEditText_' + id);
  if (!inp) return;
  const newText = inp.value.trim();
  if (!newText) { renderManageTab(); return; }
  const rule = data.conditionRules.find(r => r.id === id);
  if (!rule) return;
  if (newText !== rule.text && data.conditionRules.find(r => r.text === newText)) {
    alert('已存在相同规则'); renderManageTab(); return;
  }
  rule.text = newText;
  delete document.getElementById('conditionRulesList').dataset.editing;
  saveData(); renderManageTab();
}

function editConditionRule(id) {
  startEditCondition(id);
}

// 根据条件规则获取单元格颜色（返回颜色或 null）
function getConditionColor(content) {
  if (!data.conditionRules || !content) return null;
  for (const rule of data.conditionRules) {
    if (content.indexOf(rule.text) !== -1) return rule.color;
  }
  return null;
}

function hexToRgba(hex, alpha) {
  hex = hex.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

document.getElementById('manageModal').addEventListener('click', e => { if (e.target===e.currentTarget) closeManageModal(); });
