// ========================= 钉钉私信通知管理 =========================
let dingtalkNotificationSettings = null;
let dingtalkNotificationLoading = false;

function notificationPeople() {
  const seen = new Set();
  return [...(data.internalPeople || []), ...(data.externalPeople || [])].filter(person => {
    if (!person || !person.id || seen.has(person.id)) return false;
    seen.add(person.id);
    return true;
  });
}

function dingtalkBindingFor(personId) {
  return ((dingtalkNotificationSettings && dingtalkNotificationSettings.bindings) || [])
    .find(item => item.personId === personId);
}

function notificationStatusLabel(status) {
  return ({ pending: '等待合并', processing: '发送中', sent: '已发送', skipped: '未发送', failed: '发送失败' })[status] || status || '未知';
}

function renderDingTalkNotificationPanel() {
  const badge = document.getElementById('dingtalkConfigBadge');
  const help = document.getElementById('dingtalkConfigHelp');
  const list = document.getElementById('dingtalkBindingList');
  const logs = document.getElementById('dingtalkNotificationLogs');
  if (!badge || !help || !list || !logs) return;

  if (dingtalkNotificationLoading && !dingtalkNotificationSettings) {
    badge.textContent = '正在读取…';
    list.innerHTML = '<div class="manage-empty">正在读取人员绑定…</div>';
    return;
  }

  const settings = dingtalkNotificationSettings || { bindings: [], recent: [] };
  if (settings.enabled) {
    badge.className = 'notification-config-badge enabled';
    badge.textContent = `已开启 · ${settings.aggregateSeconds || 60} 秒合并`;
    help.textContent = '排班先保存到数据库，再异步私发；同一人员短时间内的连续修改会合并为一条消息。';
  } else if (settings.configured) {
    badge.className = 'notification-config-badge waiting';
    badge.textContent = '密钥已配置 · 尚未开启';
    help.textContent = '请在 Render 将 DINGTALK_NOTIFY_ENABLED 设为 true 后重新部署；当前不会发送消息。';
  } else {
    badge.className = 'notification-config-badge waiting';
    badge.textContent = '尚未配置密钥';
    help.textContent = '先在 Render 环境变量配置应用凭证，再填写每位老师的钉钉 userId。密钥不会进入网页或数据库。';
  }

  const people = notificationPeople();
  list.innerHTML = people.length ? people.map(person => {
    const binding = dingtalkBindingFor(person.id);
    const encodedId = encodeURIComponent(person.id);
    return `<div class="notification-binding-card" data-person-id="${esc(person.id)}" data-person-name="${esc(person.name)}">
      <div class="notification-person">
        <strong>${esc(person.name)}</strong>
        <span class="${binding ? 'is-bound' : ''}">${binding ? '已绑定' : '未绑定'}</span>
      </div>
      <input class="notification-user-id" maxlength="128" autocomplete="off" spellcheck="false"
        value="${esc(binding ? binding.dingtalkUserId : '')}" placeholder="钉钉 userId">
      <label class="notification-enable"><input type="checkbox" ${!binding || binding.enabled ? 'checked' : ''}>启用私信</label>
      <div class="notification-binding-actions">
        <button class="btn btn-p" onclick="saveDingTalkBinding('${encodedId}')">保存绑定</button>
        <button class="btn" ${binding ? '' : 'disabled'} onclick="removeDingTalkBinding('${encodedId}')">解除</button>
      </div>
    </div>`;
  }).join('') : '<div class="manage-empty">暂无可绑定人员</div>';

  const recent = settings.recent || [];
  logs.innerHTML = recent.length ? recent.map(item => {
    const timestamp = item.sentAt || item.createdAt;
    const time = timestamp ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '';
    return `<div class="notification-log-item status-${esc(item.status)}">
      <div><strong>${esc(item.personName)}</strong><span>${esc(notificationStatusLabel(item.status))}</span></div>
      <small>${esc(time)} · 操作人 ${esc(item.actorName || '未知')}</small>
      ${item.lastError ? `<p>${esc(item.lastError)}</p>` : ''}
    </div>`;
  }).join('') : '<div class="manage-empty">暂无通知记录</div>';
}

async function loadDingTalkNotificationSettings(force = false) {
  if (!isPermissionAdmin() || dingtalkNotificationLoading) return;
  if (dingtalkNotificationSettings && !force) return;
  dingtalkNotificationLoading = true;
  renderDingTalkNotificationPanel();
  try {
    const actor = permissionActor();
    const query = new URLSearchParams({ actorId: actor.id, actorName: actor.name });
    const response = await fetch(`${API_BASE}/api/admin/dingtalk-notifications?${query}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'load notification settings failed');
    dingtalkNotificationSettings = payload;
  } catch (error) {
    toast('钉钉通知设置读取失败，请重试');
  } finally {
    dingtalkNotificationLoading = false;
    renderDingTalkNotificationPanel();
  }
}

function notificationBindingCard(encodedPersonId) {
  const personId = decodeURIComponent(encodedPersonId);
  return document.querySelector(`.notification-binding-card[data-person-id="${CSS.escape(personId)}"]`);
}

async function saveDingTalkBinding(encodedPersonId) {
  if (!isPermissionAdmin()) return;
  const card = notificationBindingCard(encodedPersonId);
  if (!card) return;
  const personId = card.dataset.personId;
  const personName = card.dataset.personName;
  const dingtalkUserId = card.querySelector('.notification-user-id').value.trim();
  const enabled = card.querySelector('.notification-enable input').checked;
  if (!dingtalkUserId) { toast('请先填写钉钉 userId'); return; }
  try {
    const response = await fetch(`${API_BASE}/api/admin/dingtalk-notifications/bindings/${encodeURIComponent(personId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: permissionActor(), personName, dingtalkUserId, enabled }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'save binding failed');
    const bindings = dingtalkNotificationSettings.bindings || [];
    const index = bindings.findIndex(item => item.personId === personId);
    if (index >= 0) bindings[index] = payload.binding;
    else bindings.push(payload.binding);
    renderDingTalkNotificationPanel();
    toast(`已保存 ${personName} 的钉钉绑定`);
  } catch (error) {
    toast('绑定保存失败，请重试');
  }
}

async function removeDingTalkBinding(encodedPersonId) {
  if (!isPermissionAdmin()) return;
  const card = notificationBindingCard(encodedPersonId);
  if (!card) return;
  const personId = card.dataset.personId;
  const personName = card.dataset.personName;
  if (!confirm(`确定解除「${personName}」的钉钉私信绑定？`)) return;
  try {
    const response = await fetch(`${API_BASE}/api/admin/dingtalk-notifications/bindings/${encodeURIComponent(personId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: permissionActor() }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'remove binding failed');
    dingtalkNotificationSettings.bindings = (dingtalkNotificationSettings.bindings || [])
      .filter(item => item.personId !== personId);
    renderDingTalkNotificationPanel();
    toast('已解除钉钉绑定');
  } catch (error) {
    toast('解除绑定失败，请重试');
  }
}
