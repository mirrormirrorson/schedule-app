// ========================= 实时协作状态 =========================
// 这里只同步“谁正在编辑哪个单元格”，不发送输入内容，也不写入排班数据库或历史记录。
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

function buildPresenceContext({ mode = 'group', personId, dateStr, groupId, taskIndex = -1 }) {
  return {
    mode,
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
  presenceActivity = buildPresenceContext(context || {});
  requestPresencePulse();
}

function presenceStopEditing() {
  if (!presenceActivity) return;
  presenceActivity = null;
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
  const active = !forceInactive && !!currentUser && !!presenceActivity;
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
    if (!editor || !editor.userName || !editor.context) return;
    if (!groups.has(editor.userName)) groups.set(editor.userName, []);
    groups.get(editor.userName).push(editor);
  });
  return [...groups.entries()].map(([name, sessions]) => ({ name, sessions }));
}

function presenceCellLabel(context) {
  const dateLabel = context.dateStr ? context.dateStr.slice(5).replace('-', '/') : '';
  const dayLabel = [context.weekday, dateLabel].filter(Boolean).join(' ');
  const taskLabel = context.action === 'add'
    ? '新增任务'
    : `编辑任务 ${Number(context.taskIndex) + 1}`;
  return [context.personName || '未知人员', dayLabel, taskLabel].filter(Boolean).join(' · ');
}

function renderPresence() {
  const label = document.getElementById('presenceLabel');
  const avatars = document.getElementById('presenceAvatars');
  const list = document.getElementById('presenceList');
  if (!label || !avatars || !list) return;

  const people = groupPresenceByPerson();
  label.textContent = `${people.length} 人编辑`;
  avatars.innerHTML = people.slice(0, 3).map(person => {
    const initial = esc(String(person.name).slice(0, 1) || '?');
    return `<span class="presence-avatar-mini" style="--avatar-color:${presenceAvatarColor(person.name)}">${initial}</span>`;
  }).join('');

  if (!people.length) {
    list.innerHTML = '<div class="presence-empty"><span>✓</span><strong>暂时没有人正在编辑</strong><small>有人双击单元格后会显示在这里</small></div>';
    return;
  }

  list.innerHTML = people.map(person => {
    const isMe = currentUser && person.name === currentUser.name;
    const locations = person.sessions.map(editor => {
      const context = editor.context || {};
      return `<div class="presence-location">
        <div class="presence-location-top">
          <span>${esc(context.weekLabel || context.weekStart || '当前周')}</span>
          <b>${esc(context.groupName || '未知小组')}</b>
        </div>
        <div class="presence-cell-label">${esc(presenceCellLabel(context))}</div>
      </div>`;
    }).join('');
    return `<article class="presence-person">
      <div class="presence-person-head">
        <span class="presence-avatar" style="--avatar-color:${presenceAvatarColor(person.name)}">${esc(String(person.name).slice(0, 1) || '?')}</span>
        <div><strong>${esc(person.name)}${isMe ? '（我）' : ''}</strong><span><i></i> 正在修改</span></div>
      </div>
      <div class="presence-locations">${locations}</div>
    </article>`;
  }).join('');
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
