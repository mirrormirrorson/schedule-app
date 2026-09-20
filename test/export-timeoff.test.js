const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'view-export.js'),
  'utf8',
);

function loadExportCellView({ timeOff, blocks }) {
  const context = {
    getTimeOff: () => timeOff,
    getScheduleInfo: () => blocks,
  };
  vm.runInNewContext(`${source}\n;globalThis.__getExportCellView = getExportCellView;`, context);
  return context.__getExportCellView;
}

test('image export shows leave and hides preserved schedules for a time-off cell', () => {
  const getExportCellView = loadExportCellView({
    timeOff: { updatedBy: '测试用户' },
    blocks: [{ note: '不应出现在图片中的原排班' }],
  });

  const result = getExportCellView('p1', '2026-09-21');
  assert.equal(result.timeOff, true);
  assert.equal(result.blocks.length, 0);
});

test('image export keeps schedule blocks for a normal cell', () => {
  const blocks = [{ note: '正常排班' }];
  const getExportCellView = loadExportCellView({ timeOff: null, blocks });

  const result = getExportCellView('p1', '2026-09-22');
  assert.equal(result.timeOff, false);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].note, '正常排班');
});

test('image export renders an explicit grey 请假 marker', () => {
  assert.match(source, /leave\.textContent = '请假'/);
  assert.match(source, /td\.style\.background = '#e5e7eb'/);
  assert.match(source, /cellView\.timeOff/);
});
