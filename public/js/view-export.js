// ========================= 切换 =========================
function toggleOverviewMode() {
  ovConditionMode = !ovConditionMode;
  document.getElementById('ovModeBtn')._manualOff = !ovConditionMode;
  renderOverview();
}

function switchGroup(id) {
  if (editing) commitEdit();
  clearSelection();
  activeGroupId = id;
  renderAll();
}

function clearGroup() {
  if (!activeGroupId || activeGroupId === '__overview__') return;
  if (!confirm('确定清空当前小组本周所有排班？')) return;
  const ws = wsKey();
  const changes = [];
  if (data.schedules[ws] && data.schedules[ws][activeGroupId]) {
    Object.entries(data.schedules[ws][activeGroupId]).forEach(([key, entry]) => {
      const [personId, dateStr] = key.split(/_(.+)/);
      changes.push({ personId, dateStr, oldVal: entry, newVal: [] });
    });
    delete data.schedules[ws][activeGroupId];
  }
  if (changes.length > 0) {
        pushUndo(changes);
  }
  saveData();
  clearSelection();
  renderAll();
  toast('已清空');
}

function renderAll() {
  renderGroupTabs();
  if (weekGroups().length > 0 && !activeGroupId) activeGroupId = weekGroups()[0].id;
  const isOv = activeGroupId === '__overview__';
  document.getElementById('editPanel').style.display = isOv ? 'none' : '';
  document.getElementById('overviewPanel').style.display = isOv ? '' : 'none';
  if (isOv) renderOverview(); else renderEditTable();
}

function renderGroupTabs() {
  const ws = wsKey();
  const sched = data.schedules[ws] || {};
  const scheduleWeek = fmtFull(getMonday(new Date(Date.now() + 7*86400000)));
  const isReadonly = ws < scheduleWeek; // 只有排班周及之后才可编辑小组

  let html = '';
  if (isReadonly) {
    html += `<span style="font-size:12px;color:var(--text2);margin-right:8px;">📅 历史周（只读）</span>`;
    // 记住当前周选中的小组，切换到历史周时强制汇总表
    if (activeGroupId !== '__overview__') {
      weekActiveGroup[ws] = activeGroupId;
    }
    activeGroupId = '__overview__';
  } else {
    // 恢复到该周之前选中的小组
    if (weekActiveGroup[ws] && activeGroupId === '__overview__') {
      activeGroupId = weekActiveGroup[ws];
    }
    html += weekGroups().map((g, i) => {
      const color = (g.color || COLORS[i % COLORS.length]);
      const count = sched[g.id] ? Object.keys(sched[g.id]).length : 0;
      const active = activeGroupId === g.id;
      return `<button class="gtab${active?' active':''}" style="${active?`background:${color};color:#fff;`:`border-left:3px solid ${color};`}" onclick="switchGroup('${g.id}')">${esc(g.name)}<span class="cnt">${count}</span></button>`;
    }).join('');
  }
  const ovActive = activeGroupId === '__overview__';
  html += `<button class="gtab${ovActive?' active':''}" style="${ovActive?'background:#6b7280;color:#fff;':''}" onclick="switchGroup('__overview__')">📊 总览</button>`;
  if (!isReadonly) html += `<button class="gtab-add" onclick="openManageModal()" title="添加小组">+</button>`;
  document.getElementById('groupTabs').innerHTML = html;
}

// ========================= 导出 =========================
function exportExcel() {
  const dates = weekDates(currentWeek);
  const exportData = [['姓名', ...dates.map((d,i) => `${fmtDate(d)} ${DAY_NAMES[i]}`)]];
  const exportPeople = allPeople();
  exportPeople.forEach(p => {
    const row = [p.name];
    dates.forEach(d => {
      const blocks = getScheduleInfo(p.id, fmtFull(d));
      if (blocks.length === 0) row.push('');
      else row.push(blocks.map(b => b.note || '').join('\n'));
    });
    exportData.push(row);
  });
  const wb = XLSX.utils.book_new();
  wb.SheetNames.push('排班汇总');
  wb.Sheets['排班汇总'] = XLSX.utils.aoa_to_sheet(exportData);
  XLSX.writeFile(wb, `【内部】运营一部视频制作排期表_${wsKey()}.xlsx`);
}

async function exportImage() {
  const { canvas, container } = await buildExportCanvas();
  if (!canvas) return;

  const link = document.createElement('a');
  link.download = `OM1视频制作排班表_${wsKey()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
  document.body.removeChild(container);
  toast('图片已导出');
}

async function copyImageToClipboard() {
  const { canvas, container } = await buildExportCanvas();
  if (!canvas) return;

  try {
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('图片已复制到剪切板');
  } catch(e) {
    toast('复制失败，请尝试导出图片');
  }
  document.body.removeChild(container);
}

async function buildExportCanvas() {
  // 构建干净的导出表格
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-9999px;top:0;background:#fff;padding:20px 24px;font-family:sans-serif;';

  const title = document.createElement('h2');
  title.textContent = 'OM1视频制作排班表';
  title.style.cssText = 'text-align:center;margin:0 0 4px;font-size:18px;color:#333;';
  container.appendChild(title);

  const dates = weekDates(currentWeek);
  const weekStr = `${fmtExportDate(currentWeek)} ~ ${fmtExportDate(new Date(currentWeek.getTime()+6*86400000))}`;
  const subtitle = document.createElement('div');
  subtitle.textContent = weekStr;
  subtitle.style.cssText = 'text-align:center;margin:0 0 16px;font-size:12px;color:#999;';
  container.appendChild(subtitle);

  const table = document.createElement('table');
  table.style.cssText = 'border-collapse:collapse;width:100%;font-size:12px;';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const thName = document.createElement('th');
  thName.textContent = '姓名';
  thName.style.cssText = 'border:1px solid #ccc;padding:8px;background:#f9f9f9;font-weight:600;min-width:60px;';
  headerRow.appendChild(thName);
  dates.forEach((d, i) => {
    const th = document.createElement('th');
    th.innerHTML = `${fmtExportDate(d)}<br><small>${DAY_NAMES[i]}</small>`;
    th.style.cssText = 'border:1px solid #ccc;padding:8px 6px;background:#f9f9f9;font-weight:600;font-size:11px;min-width:70px;';
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const people = weekPeople();
  let lastCat = null;
  people.forEach(p => {
    if (p._cat !== lastCat) {
      const sepRow = document.createElement('tr');
      const sepCell = document.createElement('td');
      sepCell.colSpan = 8;
      sepCell.textContent = p._cat === 'internal' ? '内部人员' : '外协人员';
      sepCell.style.cssText = 'border:1px solid #ccc;padding:6px 8px;background:#f0f0f0;font-weight:600;font-size:12px;';
      sepRow.appendChild(sepCell);
      tbody.appendChild(sepRow);
      lastCat = p._cat;
    }
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = p.name;
    tdName.style.cssText = 'border:1px solid #ccc;padding:6px 8px;text-align:center;font-weight:500;';
    if (p._cat === 'external') {
      tdName.style.background = '#fffde7';
      tr.style.background = '#fffef5';
    }
    tr.appendChild(tdName);
    dates.forEach(d => {
      const td = document.createElement('td');
      const blocks = getScheduleInfo(p.id, fmtFull(d));
      const minH = Math.max(70, blocks.length * 35);
      td.style.cssText = `border:1px solid #ccc;padding:0;text-align:center;vertical-align:top;font-size:10px;word-break:break-word;position:relative;height:${minH}px;`;
      if (blocks.length > 0) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:stretch;justify-content:center;height:100%;box-sizing:border-box;';
        blocks.forEach(b => {
          const div = document.createElement('div');
          div.textContent = b.note || '';
          let ds = 'flex:1 1 auto;display:flex;align-items:center;justify-content:center;text-align:center;padding:3px 4px;border-radius:4px;line-height:1.4;white-space:pre-wrap;word-break:break-word;min-height:0;';
          const condColor = getConditionColor(b.note);
          if (condColor) {
            ds += `color:#222;background:${hexToRgba(condColor,0.30)};font-weight:700;`;
          }
          div.style.cssText = ds;
          wrapper.appendChild(div);
        });
        td.appendChild(wrapper);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);

  document.body.appendChild(container);
  await new Promise(r => setTimeout(r, 100));

  try {
    const canvas = await html2canvas(container, {
      backgroundColor: '#ffffff',
      scale: 2,
      logging: false,
    });
    return { canvas, container };
  } catch(e) {
    document.body.removeChild(container);
    toast('导出失败: ' + e.message);
    return { canvas: null, container };
  }
}

function copyToClipboard() {
  const dates = weekDates(currentWeek);
  const lines = [];
  lines.push(['姓名', ...dates.map((d,i) => `${fmtDate(d)} ${DAY_NAMES[i]}`)].join('\t'));
  const exportPeople = allPeople();
  exportPeople.forEach(p => {
    const cells = [p.name];
    dates.forEach(d => {
      const blocks = getScheduleInfo(p.id, fmtFull(d));
      if (blocks.length === 0) cells.push('');
      else cells.push(blocks.map(b => b.note || '').join('\n'));
    });
    lines.push(cells.join('\t'));
  });
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    toast('已复制到剪贴板');
  }).catch(() => {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = lines.join('\n');
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('已复制到剪贴板');
  });
}

// ========================= 周选择器 =========================
function updateWeekUI() {
  const end = new Date(currentWeek); end.setDate(end.getDate()+6);
  document.getElementById('weekLabel').textContent = `${fmtDate(currentWeek)} ~ ${fmtDate(end)}`;
  // 下一周期显示「排班周」标签
  const nextMonday = fmtFull(getMonday(new Date(Date.now() + 7*86400000)));
  document.getElementById('weekBadge').style.display = (wsKey() === nextMonday) ? 'inline' : 'none';
}

function goToScheduleWeek() {
  if (editing) commitEdit();
  const scheduleWeek = getMonday(new Date(Date.now() + 7*86400000));
  if (fmtFull(currentWeek) === fmtFull(scheduleWeek)) {
    toast('已在排班周');
    return;
  }
  currentWeek = scheduleWeek;
  clearSelection();
  updateWeekUI();
  renderAll();
}

function prevWeek() {
  if (editing) commitEdit();
  currentWeek = new Date(currentWeek);
  currentWeek.setDate(currentWeek.getDate() - 7);
  clearSelection();
  updateWeekUI();
  renderAll();
}

function nextWeek() {
  if (editing) commitEdit();
  currentWeek = new Date(currentWeek);
  currentWeek.setDate(currentWeek.getDate() + 7);
  clearSelection();
  updateWeekUI();
  renderAll();
}

function jumpToWeek(dateVal) {
  if (!dateVal) return;
  if (editing) commitEdit();
  currentWeek = getMonday(new Date(dateVal + 'T00:00:00'));
  clearSelection();
  updateWeekUI();
  renderAll();
}

// ========================= 小组表悬浮提示 =========================
function initCellTooltip() {
  const tooltip = document.createElement('div');
  tooltip.id = 'cellTooltip';
  tooltip.className = 'cell-tooltip';
  document.body.appendChild(tooltip);

  const editTable = document.getElementById('editTable');
  if (!editTable) return;

  function positionTooltip(e) {
    const pad = 12;
    let left = e.clientX + pad;
    let top = e.clientY + pad;
    const rect = tooltip.getBoundingClientRect();
    if (left + rect.width > window.innerWidth - pad) left = e.clientX - rect.width - pad;
    if (top + rect.height > window.innerHeight - pad) top = e.clientY - rect.height - pad;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }

  editTable.addEventListener('mouseover', e => {
    const cell = e.target.closest('.cell');
    if (!cell || cell.classList.contains('editing')) { tooltip.style.display = 'none'; return; }
    const pid = cell.dataset.pid;
    const ds = cell.dataset.date;
    if (!pid || !ds) { tooltip.style.display = 'none'; return; }
    const conflicts = getCrossGroupBlocks(pid, ds);
    if (conflicts.length === 0) { tooltip.style.display = 'none'; return; }
    const items = conflicts.map(b => {
      const note = esc(b.note || '').replace(/\n/g, '<br>');
      return `<div class="tip-item"><span class="tip-group">${esc(b.groupName)}</span><div class="tip-content">${note}</div></div>`;
    }).join('');
    tooltip.innerHTML = `<div class="tip-title">⚠ 其它小组已在此处排期</div>${items}<div class="tip-message">已在此处填写排期，请大家先自行协调安排，如解决不了填入后等待排班负责人协调~</div>`;
    tooltip.style.display = 'block';
    positionTooltip(e);
  });

  editTable.addEventListener('mousemove', e => {
    if (tooltip.style.display === 'block') positionTooltip(e);
  });

  editTable.addEventListener('mouseout', e => {
    if (e.target.closest('.cell')) tooltip.style.display = 'none';
  });
}
