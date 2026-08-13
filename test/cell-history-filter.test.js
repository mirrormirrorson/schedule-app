const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('week-only people are displayed in stable category order', () => {
  const source = read('public/js/schedule-core.js');
  const start = source.indexOf('function orderWeekPeopleForDisplay');
  const end = source.indexOf('\nfunction weekPeople()', start);
  assert.ok(start >= 0 && end > start);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);
  const input = [
    { id: 'p1', name: '常用内部', _cat: 'internal' },
    { id: 'e1', name: '外协', _cat: 'external' },
    { id: 'p2', name: '临时内部', _cat: 'internal' },
  ];
  const output = vm.runInContext(`orderWeekPeopleForDisplay(${JSON.stringify(input)})`, sandbox);
  assert.deepEqual(Array.from(output, item => item.id), ['p1', 'p2', 'e1']);
  assert.deepEqual(input.map(item => item.id), ['p1', 'e1', 'p2']);
});

function historySandbox() {
  const sandbox = {
    document: { addEventListener() {} },
    fmtFull(date) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/identity-history.js'), sandbox);
  return sandbox;
}

test('cell history matches direct changes and both ends of moves', () => {
  const sandbox = historySandbox();
  const context = {
    week: '2026-08-17', groupId: 'g1', group: '臣妾组', overview: false,
    personId: 'p2', person: '临时人员', date: '2026-08-19', weekday: '周三',
  };
  const matches = entry => vm.runInContext(
    `historyEntryTouchesCell(${JSON.stringify(entry)}, ${JSON.stringify(context)})`, sandbox
  );
  assert.equal(matches({ week:'2026-08-17', groupId:'g1', group:'臣妾组', personId:'p2', person:'临时人员', date:'2026-08-19', action:'modify' }), true);
  assert.equal(matches({ week:'2026-08-17', groupId:'g1', group:'臣妾组', personId:'p2', person:'临时人员', date:'2026-08-20', action:'modify' }), false);
  assert.equal(matches({ week:'2026-08-17', groupId:'g1', group:'臣妾组', action:'move', fromPersonId:'p2', fromDate:'2026-08-19', toPersonId:'p3', toDate:'2026-08-20' }), true);
  assert.equal(matches({ week:'2026-08-17', group:'臣妾组', action:'move', fromLabel:'其他人·周二', toLabel:'临时人员·周三' }), true);
  assert.equal(matches({ week:'2026-08-17', groupId:'g2', group:'未来组', personId:'p2', person:'临时人员', date:'2026-08-19', action:'modify' }), false);
});

test('cell history follows task content back through moves to its original add', () => {
  const sandbox = historySandbox();
  const entries = [
    { id:'move2', ts:'2026-08-13T02:21:33.517Z', week:'2026-08-17', group:'坐以待币组', groupId:'g1', action:'move', content:'111', fromLabel:'顺斌·周一', toLabel:'阿文·周二', fromPersonId:'p2', fromDate:'2026-08-17', toPersonId:'p1', toDate:'2026-08-18' },
    { id:'move1', ts:'2026-08-13T02:21:26.147Z', week:'2026-08-17', group:'坐以待币组', groupId:'g1', action:'move', content:'111', fromLabel:'阿文·周一', toLabel:'顺斌·周一', fromPersonId:'p1', fromDate:'2026-08-17', toPersonId:'p2', toDate:'2026-08-17' },
    { id:'add', ts:'2026-08-13T02:21:15.103Z', week:'2026-08-17', group:'坐以待币组', groupId:'g1', person:'阿文', personId:'p1', date:'2026-08-17', weekday:'周一', action:'add', content:'111', detail:{old:'',new:'111'} },
    { id:'other', ts:'2026-08-13T02:21:20.000Z', week:'2026-08-17', group:'坐以待币组', groupId:'g1', person:'其他人', personId:'p3', date:'2026-08-17', weekday:'周一', action:'add', content:'111', detail:{old:'',new:'111'} },
  ];
  const context = {
    week:'2026-08-17', groupId:'g1', group:'坐以待币组', overview:false,
    personId:'p1', person:'阿文', date:'2026-08-18', weekday:'周二',
    blocks:[{groupId:'g1',group:'坐以待币组',note:'111'}],
  };
  const ids = vm.runInContext(
    `historyEntriesForCell(${JSON.stringify(entries)}, ${JSON.stringify(context)}).map(entry => entry.id)`, sandbox
  );
  assert.deepEqual(Array.from(ids), ['move2', 'move1', 'add']);
});
