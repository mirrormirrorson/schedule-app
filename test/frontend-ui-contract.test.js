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
  assert.match(presence, /editor\.sessionId === presenceSessionId/);
  assert.match(presence, /context\.weekStart !== wsKey\(\)/);
  assert.match(presence, /context\.groupId !== activeGroupId/);
  assert.doesNotMatch(presence, /presenceCellLabel/);
  assert.match(presence, /navigator\.sendBeacon/);
  assert.doesNotMatch(presence, /\.note\b|textarea\.value|editInput/);
  assert.match(schedule, /presenceSelectCell/);
  assert.match(schedule, /presenceStartEditing\(\{ mode: 'group'/);
  assert.match(schedule, /presenceStopEditing\(\)/);
  assert.match(css, /\.presence-hub:hover \.presence-popover/);
  assert.match(css, /\.presence-person/);
  assert.match(css, /\.cell\.remote-presence-cell/);
  assert.match(css, /\.remote-presence-tag/);
});
