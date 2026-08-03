// ========================= 账号权限管理 =========================
const PERMISSION_ADMIN_NAMES = new Set(['张雅镜', '林俊凯', '简慧仪']);
let managedPermissionUsers = [];
let permissionUsersLoading = false;

function isPermissionAdmin() {
  return !!currentUser && (currentUser.isPermissionAdmin === true || PERMISSION_ADMIN_NAMES.has(currentUser.name));
}

function currentRadarPermissions() {
  if (isPermissionAdmin()) return { canScoreRadar: true, canManageRadarFields: true };
  return currentUser && currentUser.permissions ? currentUser.permissions : {};
}

function canScoreRadar() {
  return currentRadarPermissions().canScoreRadar === true;
}

function canManageRadarFields() {
  return currentRadarPermissions().canManageRadarFields === true;
}

function requireRadarPermission(kind = 'score') {
  const allowed = kind === 'fields' ? canManageRadarFields() : canScoreRadar();
  if (allowed) return true;
  alert('暂无权限，请联系林俊凯修改');
  return false;
}

function permissionActor() {
  return currentUser ? { id: currentUser.id, name: currentUser.name } : null;
}

function updatePermissionTabVisibility() {
  const tab = document.getElementById('permissionManageTab');
  if (tab) tab.style.display = isPermissionAdmin() ? '' : 'none';
  if (!isPermissionAdmin() && manageActiveTab === 'permissions') switchManageTab('people');
}

function permissionUserCard(user) {
  const protectedAdmin = user.isPermissionAdmin === true;
  const permissions = user.permissions || {};
  const lastSeen = user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleString('zh-CN', { hour12: false }) : '暂无记录';
  return `<div class="permission-user-card">
    <div class="permission-user-head">
      <div><strong>${esc(user.name)}</strong>${protectedAdmin ? '<span class="permission-admin-badge">权限管理员</span>' : ''}</div>
      <small>最近登录：${esc(lastSeen)}</small>
    </div>
    <div class="permission-switches">
      <label><input type="checkbox" ${permissions.canScoreRadar ? 'checked' : ''} ${protectedAdmin ? 'disabled' : ''} onchange="updateManagedPermission('${user.id}','canScoreRadar',this.checked)"><span>填写雷达评分</span></label>
      <label><input type="checkbox" ${permissions.canManageRadarFields ? 'checked' : ''} ${protectedAdmin ? 'disabled' : ''} onchange="updateManagedPermission('${user.id}','canManageRadarFields',this.checked)"><span>维护雷达字段</span></label>
    </div>
    <button class="btn permission-delete" ${protectedAdmin ? 'disabled title="权限管理员账号受保护"' : ''} onclick="deleteManagedAccount('${user.id}')">删除账号</button>
  </div>`;
}

function renderPermissionsPanel() {
  const list = document.getElementById('permissionUserList');
  const count = document.getElementById('permissionUserCount');
  if (!list || !count) return;
  count.textContent = `${managedPermissionUsers.length} 个账号`;
  if (permissionUsersLoading) {
    list.innerHTML = '<div class="manage-empty">正在读取账号权限…</div>';
    return;
  }
  list.innerHTML = managedPermissionUsers.length
    ? managedPermissionUsers.map(permissionUserCard).join('')
    : '<div class="manage-empty">暂无登录账号</div>';
}

async function loadPermissionUsers() {
  if (!isPermissionAdmin() || permissionUsersLoading) return;
  permissionUsersLoading = true;
  renderPermissionsPanel();
  try {
    const actor = permissionActor();
    const query = new URLSearchParams({ actorId: actor.id, actorName: actor.name });
    const response = await fetch(`${API_BASE}/api/admin/users?${query}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'load users failed');
    managedPermissionUsers = payload.users || [];
  } catch (error) {
    toast('账号权限读取失败，请重试');
  } finally {
    permissionUsersLoading = false;
    renderPermissionsPanel();
  }
}

async function updateManagedPermission(userId, key, enabled) {
  if (!isPermissionAdmin()) return;
  const user = managedPermissionUsers.find(item => item.id === userId);
  if (!user || user.isPermissionAdmin) { renderPermissionsPanel(); return; }
  const permissions = { ...(user.permissions || {}), [key]: enabled === true };
  try {
    const response = await fetch(`${API_BASE}/api/admin/users/${encodeURIComponent(userId)}/permissions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: permissionActor(), permissions }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'update permission failed');
    Object.assign(user, payload.user);
    renderPermissionsPanel();
    toast('账号权限已更新');
  } catch (error) {
    renderPermissionsPanel();
    toast('权限修改失败，请重试');
  }
}

async function deleteManagedAccount(userId) {
  if (!isPermissionAdmin()) return;
  const user = managedPermissionUsers.find(item => item.id === userId);
  if (!user || user.isPermissionAdmin) return;
  if (!confirm(`确定删除登录账号「${user.name}」？\n不会删除该人员的排班、历史或人员名单。`)) return;
  try {
    const response = await fetch(`${API_BASE}/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: permissionActor() }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'delete user failed');
    managedPermissionUsers = managedPermissionUsers.filter(item => item.id !== userId);
    renderPermissionsPanel();
    toast('登录账号已删除');
  } catch (error) {
    toast('账号删除失败，请重试');
  }
}
