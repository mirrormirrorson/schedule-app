const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCalendar() {
  const window = {};
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'work-calendar.js'), 'utf8');
  vm.runInNewContext(source, { window });
  return window.WorkCalendar;
}

test('2026 official holiday overrides distinguish rest days and adjusted workdays', () => {
  const calendar = loadCalendar();
  assert.deepEqual(
    JSON.parse(JSON.stringify(calendar.getDayInfo('2026-09-20'))),
    { date: '2026-09-20', kind: 'work', mark: '班', name: '国庆节调休', adjusted: true, official: true },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(calendar.getDayInfo('2026-09-25'))),
    { date: '2026-09-25', kind: 'rest', mark: '休', name: '中秋节', adjusted: false, official: true },
  );
});

test('ordinary dates fall back to weekday and weekend rules', () => {
  const calendar = loadCalendar();
  assert.equal(calendar.getDayInfo('2026-09-14').kind, 'work');
  assert.equal(calendar.getDayInfo('2026-09-19').kind, 'rest');
});
