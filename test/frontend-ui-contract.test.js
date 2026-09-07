const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('cell editing remains on the original textarea interaction', () => {
  const source = read('public/js/schedule-core.js');
  const css = read('public/css/app.css');
  assert.match(source, /<textarea placeholder="输入任务" id="editInput"><\/textarea>/);
  assert.match(source, /ta\.value = oldVal/);
  assert.match(source, /cellEl\.innerHTML = `<textarea/);
  assert.doesNotMatch(source, /contenteditable="true"/);
  assert.doesNotMatch(source, /entry-editor-host/);
  assert.match(css, /\.cell\.editing textarea\s*\{/);
  assert.match(css, /\.et-block\s*\{[\s\S]*flex:\s*1 1 0/);
  assert.doesNotMatch(css, /\.et-block-editor\s*\{/);
});

test('history opens with the current week and current group context', () => {
  const source = read('public/js/identity-history.js');
  assert.match(source, /historyOpenContext = \{ week: wsKey\(\), group: currentGroup \}/);
  assert.match(source, /activeGroupId !== '__overview__'/);
  assert.match(source, /loadAllHistory\(true\)/);
  assert.match(source, /全部小组/);
});

test('history refresh is conditional and no longer downloads every four seconds', () => {
  const source = read('public/js/identity-history.js');
  assert.match(source, /'If-None-Match': historyResponseTag/);
  assert.match(source, /res\.status === 304/);
  assert.match(source, /}, 60000\);/);
  assert.doesNotMatch(source, /}, 4000\);/);
});

test('condition colors are redesigned while themes remain unchanged', () => {
  const source = read('public/js/management.js');
  const html = read('public/index.html');
  const css = read('public/css/enhancements.css');
  for (const label of ['重点鲜明', '柔和浅色', '冷静蓝绿', '暖色能量', '低饱和', '深色对比']) {
    assert.match(source, new RegExp(label));
  }
  for (const label of ['柔和粉', '蓝白专业', '科技深空', '薄荷清新']) {
    assert.match(source, new RegExp(label));
  }
  assert.match(html, /id="customCondColor"/);
  assert.doesNotMatch(source, /schedule_font_size/);
  assert.doesNotMatch(source, /可爱手帐风|简约办公风|未来科技风|清新自然风/);
  assert.match(css, /\.condition-color,[\s\S]*width:\s*24px/);
  assert.match(css, /\.manage-close\s*\{[\s\S]*place-items:\s*center/);
});

test('history cards present week, table, content and move route as distinct regions', () => {
  const source = read('public/js/identity-history.js');
  const css = read('public/css/enhancements.css');
  assert.match(source, /年\$\{t\.getMonth\(\) \+ 1\}月/);
  assert.match(source, /class="hd-detail-row"/);
  assert.match(source, /<span class="hd-detail-label">内容<\/span>/);
  assert.match(source, /<span class="hd-detail-label">位置<\/span>/);
  assert.match(source, /class="hd-route-point old"/);
  assert.match(source, /class="hd-route-arrow"/);
  assert.match(source, /class="hd-route-point new"/);
  assert.doesNotMatch(source, /<small>周次<\/small>/);
  assert.match(css, /\.hd-route\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,1fr\) 26px minmax\(0,1fr\)/);
});

test('person history distinguishes template and week sources without a position row', () => {
  const history = read('public/js/identity-history.js');
  const management = read('public/js/management.js');
  assert.match(history, /const PERSON_ACTIONS = new Set/);
  assert.match(history, /return '本周人员名单'/);
  assert.match(history, /return '常用人员模板'/);
  assert.match(history, /personAction \? personDetailHtml/);
  assert.match(history, /<span class="hd-detail-label">人员<\/span>/);
  assert.match(history, /<span class="hd-detail-label">人员变更<\/span>/);
  assert.match(management, /logPersonAction\('addPerson', name, 'template'/);
  assert.match(management, /logPersonAction\('addPerson', val\.trim\(\), 'week'/);
  assert.match(management, /logPersonAction\('removeFromWeek', person\.name, 'week'/);
});

test('background renderer remains on the pre-redesign implementation', () => {
  const background = read('public/js/background.js');
  const css = read('public/css/app.css');
  assert.match(background, /function draw\(/);
  assert.doesNotMatch(background, /drawBow\(|drawHeart\(|drawLeaf\(/);
  assert.doesNotMatch(css, /整页风格主题|--shell-surface|body \.table-card::before/);
});

test('live presence lists online people and renders same-group cell cursors', () => {
  const html = read('public/index.html');
  const presence = read('public/js/presence.js');
  const schedule = read('public/js/schedule-core.js');
  const css = read('public/css/app.css');

  assert.match(html, /id="presenceHub"/);
  assert.match(html, /id="presencePopover"/);
  assert.match(html, /0 人在线/);
  assert.match(html, /操作位置会直接显示在排班表格中/);
  assert.match(html, /\/js\/presence\.js/);
  assert.match(presence, /PRESENCE_HEARTBEAT_MS = 4_000/);
  assert.match(presence, /groupPresenceByPerson/);
  assert.match(presence, /renderRemoteCellPresence/);
  assert.match(presence, /remote-presence-tag/);
  assert.match(presence, /presenceStartDragging/);
  assert.match(presence, /正在移动/);
  assert.match(presence, /editor\.sessionId === presenceSessionId/);
  assert.match(presence, /context\.weekStart !== wsKey\(\)/);
  assert.match(presence, /context\.groupId !== activeGroupId/);
  assert.doesNotMatch(presence, /presenceCellLabel/);
  assert.match(presence, /navigator\.sendBeacon/);
  assert.doesNotMatch(presence, /\.note\b|textarea\.value|editInput/);
  assert.match(schedule, /presenceSelectCell/);
  assert.match(schedule, /syncDraggingCell/);
  assert.match(schedule, /syncPresenceCell\(personId, dateStr, 'dragging'\)/);
  assert.match(schedule, /presenceStartEditing\(\{ mode: 'group'/);
  assert.match(schedule, /presenceStopEditing\(\)/);
  assert.match(css, /\.presence-hub:hover \.presence-popover/);
  assert.match(css, /\.presence-person/);
  assert.match(css, /\.cell\.remote-presence-cell/);
  assert.match(css, /\.remote-presence-tag/);
});

test('shared radar fields and per-person scores render from every schedule row head', () => {
  const html = read('public/index.html');
  const management = read('public/js/management.js');
  const schedule = read('public/js/schedule-core.js');
  const bootstrap = read('public/js/bootstrap.js');
  const css = read('public/css/app.css');
  const sync = read('public/js/state-sync.js');
  const server = read('server.js');

  assert.match(html, /id="radarFieldList"/);
  assert.match(html, /所有人员共用同一套字段/);
  assert.match(management, /function addRadarField\(\)/);
  assert.match(management, /function updateRadarField\(id, value\)/);
  assert.match(management, /function editPersonRadar\(id\)/);
  assert.match(management, /data\.personRadarScores\[id\] = collect\(\)/);
  assert.doesNotMatch(management, /function editPersonIntro/);
  assert.match(schedule, /function resolvePersonRadar\(personId\)/);
  assert.match(schedule, /function buildPersonRadarSVG\(fields, scores/);
  assert.match(schedule, /function splitRadarLabel\(value, maxChars = 6\)/);
  assert.match(schedule, /function personNameHTML\(person\)/);
  assert.match(schedule, /function initPersonRadarTooltip\(\)/);
  assert.match(schedule, /let pinnedTarget = null/);
  assert.match(schedule, /document\.addEventListener\('click',[\s\S]*?\}, true\);/);
  assert.match(schedule, /show\(target, true\)/);
  assert.match(schedule, /点击空白处关闭/);
  assert.doesNotMatch(schedule, /field\.name\)\.slice\(0, 12\)/);
  assert.equal((schedule.match(/\$\{personNameHTML\(/g) || []).length, 2);
  assert.match(bootstrap, /initPersonRadarTooltip\(\)/);
  assert.match(css, /\.person-name\.has-radar/);
  assert.match(css, /\.person-radar-tooltip\.visible/);
  assert.match(css, /width: min\(560px, calc\(100vw - 24px\)\)/);
  assert.match(css, /\.person-radar-tooltip\.pinned/);
  assert.match(css, /overflow-wrap: anywhere; white-space: normal/);
  assert.match(css, /\.person-radar-modal/);
  assert.match(sync, /'personRadarFields', 'personRadarScores'/);
  assert.match(server, /'personRadarFields'/);
  assert.match(server, /'personRadarScores'/);
});

test('radar management is last in personnel settings and uses account permissions', () => {
  const html = read('public/index.html');
  const management = read('public/js/management.js');
  const permissions = read('public/js/permissions.js');
  const sync = read('public/js/state-sync.js');
  const server = read('server.js');
  const migration = read('migrations/001_init.sql');
  const externalList = html.indexOf('id="manageExternalTags"');
  const radarSection = html.indexOf('class="modal-section radar-field-section"');

  assert.ok(externalList >= 0 && radarSection > externalList);
  assert.match(permissions, /new Set\(\['张雅镜', '林俊凯', '简慧仪'\]\)/);
  assert.match(permissions, /function canScoreRadar\(\)/);
  assert.match(permissions, /function canManageRadarFields\(\)/);
  assert.match(permissions, /alert\('暂无权限，请联系林俊凯修改'\)/);
  assert.match(management, /function addRadarField\(\) \{\s+if \(!requireRadarPermission\('fields'\)\) return;/);
  assert.match(management, /function editPersonRadar\(id\) \{\s+if \(!requireRadarPermission\('score'\)\) return;/);
  assert.match(sync, /actor: typeof currentUser/);
  assert.match(server, /radar permission denied/);
  assert.match(sync, /未授权的雷达修改没有保存/);
  assert.match(sync, /payload\.deniedRoots/);
  assert.match(migration, /can_score_radar BOOLEAN/);
  assert.match(migration, /can_manage_radar_fields BOOLEAN/);
});

test('permission panel is visible only to protected admins and manages account capabilities', () => {
  const html = read('public/index.html');
  const permissions = read('public/js/permissions.js');
  const server = read('server.js');

  assert.match(html, /id="permissionManageTab" style="display:none"/);
  assert.match(html, /id="panelPermissions"/);
  assert.match(html, /张雅镜、林俊凯、简慧仪为受保护的权限管理员/);
  assert.match(permissions, /function isPermissionAdmin\(\)/);
  assert.match(permissions, /function loadPermissionUsers\(\)/);
  assert.match(permissions, /function updateManagedPermission\(userId, key, enabled\)/);
  assert.match(permissions, /function deleteManagedAccount\(userId\)/);
  assert.match(server, /app\.get\('\/api\/admin\/users'/);
  assert.match(server, /app\.patch\('\/api\/admin\/users\/:id\/permissions'/);
  assert.match(server, /app\.delete\('\/api\/admin\/users\/:id'/);
});

test('future scheduling cycles are editable only by protected admins', () => {
  const schedule = read('public/js/schedule-core.js');
  const sync = read('public/js/state-sync.js');
  const server = read('server.js');
  assert.match(schedule, /function scheduleWeekKey\(\)/);
  assert.match(schedule, /function canEditScheduleWeek\(weekKey = wsKey\(\)\)/);
  assert.match(schedule, /typeof isPermissionAdmin === 'function' && isPermissionAdmin\(\)/);
  assert.match(schedule, /toast\('还未进入排班时间'\)/);
  assert.match(schedule, /document\.addEventListener\('dblclick',[\s\S]*?requireScheduleWeekEdit\(\)/);
  assert.match(schedule, /async function pasteToSelection\(\) \{\s*if \(!requireScheduleWeekEdit\(\)\) return;/);
  assert.match(schedule, /function ovEntryEdit\([\s\S]*?if \(!requireScheduleWeekEdit\(\)\) return;/);
  assert.match(sync, /payload\.error === 'future schedule permission denied'/);
  assert.match(server, /function scheduleWeekKeyForShanghai\(now = new Date\(\)\)/);
  assert.match(server, /futureScheduleWeeksFromChanges\(changes\)/);
  assert.match(server, /error: 'future schedule permission denied'/);
});

test('temporary internal people stay in the existing internal section', () => {
  const schedule = read('public/js/schedule-core.js');
  const management = read('public/js/management.js');
  assert.match(schedule, /function rawWeekPeople\(\)/);
  assert.match(schedule, /function orderWeekPeopleForDisplay\(list\)/);
  assert.match(schedule, /leftRank - rightRank \|\| left\.index - right\.index/);
  assert.match(schedule, /return orderWeekPeopleForDisplay\(rawWeekPeople\(\)\)/);
  assert.match(management, /rawWeekPeople\(\)\.push\(newPerson\)/);
  assert.match(management, /const wp = rawWeekPeople\(\)/);
});

test('right-clicking a schedule cell opens its complete cell history', () => {
  const html = read('public/index.html');
  const history = read('public/js/identity-history.js');
  const css = read('public/css/enhancements.css');
  assert.match(html, /右键查看该格历史/);
  assert.match(html, /id="historyCellFilter"/);
  assert.match(history, /document\.addEventListener\('contextmenu'/);
  assert.match(history, /function openCellHistoryDrawer\(context\)/);
  assert.match(history, /function historyEntryTouchesCell\(entry, context\)/);
  assert.match(history, /function historyEntriesForCell\(entries, context\)/);
  assert.match(history, /moveSourceLocation\(candidate, location\)/);
  assert.match(history, /entry\.fromPersonId === context\.personId/);
  assert.match(history, /entry\.toPersonId === context\.personId/);
  assert.match(history, /该单元格暂无修改记录/);
  assert.match(css, /\.hd-cell-filter\s*\{/);
});

test('calendar headers use official workday and rest-day metadata in every schedule view', () => {
  const html = read('public/index.html');
  const schedule = read('public/js/schedule-core.js');
  const css = read('public/css/app.css');
  assert.match(html, /\/js\/work-calendar\.js/);
  assert.match(schedule, /function calendarHeaderHTML\(date, dayIndex\)/);
  assert.equal((schedule.match(/calendarHeaderHTML\(d, i\)/g) || []).length, 2);
  assert.match(css, /\.schedule-table thead th\.calendar-day-work/);
  assert.match(css, /\.schedule-table thead th\.calendar-day-rest/);
  assert.doesNotMatch(html, /timeOffModal/);
  assert.doesNotMatch(schedule, /getTimeOff/);
});
