// ========================= 实时协作状态 =========================
// 这里只同步“谁在线、谁选中了哪个单元格”，不发送输入内容，也不写入排班数据库或历史记录。
const PRESENCE_HEARTBEAT_MS = 4_000;
const PRESENCE_STALE_MS = 16_000;
const presenceSessionId = (() => {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return `p_${window.crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
})();

let presenceActivity = null;
let presenceEditors = [];
let presenceTimer = null;
let presenceRequestRunning = false;
let presenceRequestQueued = false;
let presenceLastSuccess = 0;
let presenceInitialized = false;

function presenceWeekLabel() {
  if (!currentWeek) return '';
  const end = new Date(currentWeek);
  end.setDate(end.getDate() + 6);
  return `${fmtDate(currentWeek)}～${fmtDate(end)}`;
}

function buildPresenceContext({ mode = 'group', status = 'selected', personId, dateStr, groupId, taskIndex = -1 }) {
  return {
    mode,
    status: status === 'editing' ? 'editing' : 'selected',
    action: taskIndex < 0 ? 'add' : 'edit',
    weekStart: wsKey(),
    weekLabel: presenceWeekLabel(),
    groupId: groupId || activeGroupId || '',
    groupName: resolveGroupName(groupId || activeGroupId),
    personId: personId || '',
    personName: resolvePersonName(personId),
    dateStr: dateStr || '',
    weekday: weekdayName(dateStr),
    taskIndex: Number.isInteger(taskIndex) ? taskIndex : -1,
  };
}

function presenceStartEditing(context) {
  presenceActivity = buildPresenceContext({ ...(context || {}), status: 'editing' });
  requestPresencePulse();
}

function presenceSelectCell(context) {
  if (activeGroupId === '__overview__') return presenceClearCell();
  presenceActivity = buildPresenceContext({ ...(context || {}), status: 'selected' });
  requestPresencePulse();
}

function currentSelectionPresence() {
  if (!activeCell || activeGroupId === '__overview__') return null;
  const people = weekPeople();
  const dates = weekDates(currentWeek);
  const person = people[activeCell.r];
  const date = dates[activeCell.c];
  if (!person || !date) return null;
  return buildPresenceContext({
    mode: 'group', status: 'selected', personId: person.id,
    dateStr: fmtFull(date), groupId: activeGroupId, taskIndex: -1,
  });
}

function presenceStopEditing() {
  presenceActivity = currentSelectionPresence();
  requestPresencePulse();
}

function presenceClearCell() {
  if (!presenceActivity) return;
  presenceActivity = null;
  requestPresencePulse();
}

function presenceViewChanged() {
  if (presenceActivity && (
    activeGroupId === '__overview__'
    || presenceActivity.weekStart !== wsKey()
    || presenceActivity.groupId !== activeGroupId
  )) presenceActivity = null;
  renderRemoteCellPresence();
  requestPresencePulse();
}

function presenceIdentityChanged() {
  requestPresencePulse();
}

function schedulePresencePulse(delay = PRESENCE_HEARTBEAT_MS) {
  if (presenceTimer) clearTimeout(presenceTimer);
  if (document.hidden) return;
  presenceTimer = setTimeout(() => pulsePresence(), delay);
}

function requestPresencePulse() {
  if (!presenceInitialized || document.hidden) return;
  if (presenceRequestRunning) {
    presenceRequestQueued = true;
    return;
  }
  schedulePresencePulse(0);
}

async function pulsePresence(options = {}) {
  if (!presenceInitialized || presenceRequestRunning) return;
  presenceRequestRunning = true;
  const forceInactive = options.forceInactive === true;
  const active = !forceInactive && !!currentUser;
  try {
    updatePresenceConnection('connecting');
    const response = await fetch(`${API_BASE}/api/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      keepalive: forceInactive,
      body: JSON.stringify({
        sessionId: presenceSessionId,
        userName: currentUser ? currentUser.name : '',
        active,
        context: active ? presenceActivity : null,
      }),
    });
    if (!response.ok) throw new Error(`presence ${response.status}`);
    const payload = await response.json();
    presenceEditors = Array.isArray(payload.editors) ? payload.editors : [];
    presenceLastSuccess = Date.now();
    renderPresence();
    updatePresenceConnection('online');
  } catch (error) {
    if (Date.now() - presenceLastSuccess > PRESENCE_STALE_MS) {
      presenceEditors = [];
      renderPresence();
    }
    updatePresenceConnection('offline');
  } finally {
    presenceRequestRunning = false;
    if (presenceRequestQueued) {
      presenceRequestQueued = false;
      schedulePresencePulse(0);
    } else if (!forceInactive) {
      schedulePresencePulse();
    }
  }
}

function presenceAvatarColor(name) {
  const palette = ['#ec4899', '#8b5cf6', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#f97316'];
  let hash = 0;
  for (const char of String(name || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function groupPresenceByPerson() {
  const groups = new Map();
  presenceEditors.forEach(editor => {
    if (!editor || !editor.userName) return;
    if (!groups.has(editor.userName)) groups.set(editor.userName, []);
    groups.get(editor.userName).push(editor);
  });
  return [...groups.entries()].map(([name, sessions]) => ({ name, sessions }));
}

function renderRemoteCellPresence() {
  const cells = [...document.querySelectorAll('#editTable [data-pid][data-date]')];
  cells.forEach(cell => {
    cell.classList.remove('remote-presence-cell');
    cell.style.removeProperty('--remote-presence-color');
    cell.querySelectorAll(':scope > .remote-presence-tag').forEach(tag => tag.remove());
  });
  if (!cells.length || activeGroupId === '__overview__') return;

  const locations = new Map();
  presenceEditors.forEach(editor => {
    const context = editor && editor.context;
    if (!context || editor.sessionId === presenceSessionId) return;
    if (context.mode !== 'group' || context.weekStart !== wsKey() || context.groupId !== activeGroupId) return;
    if (!context.personId || !context.dateStr) return;
    const key = `${context.personId}\u0000${context.dateStr}`;
    if (!locations.has(key)) locations.set(key, []);
    const names = locations.get(key);
    if (!names.includes(editor.userName)) names.push(editor.userName);
  });

  locations.forEach((names, key) => {
    const [personId, dateStr] = key.split('\u0000');
    const cell = cells.find(item => item.dataset.pid === personId && item.dataset.date === dateStr);
    if (!cell || !names.length) return;
    const color = presenceAvatarColor(names[0]);
    cell.classList.add('remote-presence-cell');
    cell.style.setProperty('--remote-presence-color', color);
    const tag = document.createElement('span');
    tag.className = 'remote-presence-tag';
    tag.style.setProperty('--remote-presence-color', color);
    tag.textContent = `${names.join('、')}正在编辑`;
    tag.title = tag.textContent;
    cell.appendChild(tag);
  });
}

function renderPresence() {
  const label = document.getElementById('presenceLabel');
  const avatars = document.getElementById('presenceAvatars');
  const list = document.getElementById('presenceList');
  if (!label || !avatars || !list) return;

  const people = groupPresenceByPerson();
  label.textContent = `${people.length} 人在线`;
  avatars.innerHTML = people.slice(0, 3).map(person => {
    const initial = esc(String(person.name).slice(0, 1) || '?');
    return `<span class="presence-avatar-mini" style="--avatar-color:${presenceAvatarColor(person.name)}">${initial}</span>`;
  }).join('');

  if (!people.length) {
    list.innerHTML = '<div class="presence-empty"><span>○</span><strong>暂时没有人在线</strong><small>同事打开排班网页后会显示在这里</small></div>';
    renderRemoteCellPresence();
    return;
  }

  list.innerHTML = people.map(person => {
    const isMe = currentUser && person.name === currentUser.name;
    return `<article class="presence-person">
      <div class="presence-person-head">
        <span class="presence-avatar" style="--avatar-color:${presenceAvatarColor(person.name)}">${esc(String(person.name).slice(0, 1) || '?')}</span>
        <div><strong>${esc(person.name)}${isMe ? '（我）' : ''}</strong><span><i></i> 在线</span></div>
      </div>
    </article>`;
  }).join('');
  renderRemoteCellPresence();
}

function updatePresenceConnection(state) {
  const el = document.getElementById('presenceConnection');
  const hub = document.getElementById('presenceHub');
  if (!el || !hub) return;
  hub.dataset.connection = state;
  el.textContent = state === 'online' ? '实时' : state === 'offline' ? '重连中' : '连接中';
}

function closePresencePopover() {
  const hub = document.getElementById('presenceHub');
  const button = document.getElementById('presenceSummary');
  if (hub) hub.classList.remove('open');
  if (button) button.setAttribute('aria-expanded', 'false');
}

function togglePresencePopover(event) {
  if (event) event.stopPropagation();
  const hub = document.getElementById('presenceHub');
  const button = document.getElementById('presenceSummary');
  if (!hub || !button) return;
  const open = !hub.classList.contains('open');
  hub.classList.toggle('open', open);
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function leavePresence() {
  if (!presenceInitialized) return;
  const body = JSON.stringify({
    sessionId: presenceSessionId,
    userName: currentUser ? currentUser.name : '',
    active: false,
  });
  if (navigator.sendBeacon) {
    navigator.sendBeacon(`${API_BASE}/api/presence`, new Blob([body], { type: 'application/json' }));
  } else {
    fetch(`${API_BASE}/api/presence`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true,
    }).catch(() => undefined);
  }
}

function initPresence() {
  if (presenceInitialized) return;
  presenceInitialized = true;
  const button = document.getElementById('presenceSummary');
  if (button) button.addEventListener('click', togglePresencePopover);
  document.addEventListener('click', event => {
    const hub = document.getElementById('presenceHub');
    if (hub && !hub.contains(event.target)) closePresencePopover();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closePresencePopover();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (presenceTimer) clearTimeout(presenceTimer);
      pulsePresence({ forceInactive: true });
    } else {
      requestPresencePulse();
    }
  });
  window.addEventListener('pagehide', leavePresence);
  renderPresence();
  pulsePresence();
}
