const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createFrontendContext(confirmResult = true) {
  const values = new Map();
  const windowEvents = new Map();
  const documentEvents = new Map();
  const context = vm.createContext({
    console,
    JSON,
    Date,
    Math,
    Map,
    Set,
    Promise,
    setTimeout,
    clearTimeout,
    navigator: { onLine: true },
    confirm: () => confirmResult,
    localStorage: {
      getItem: key => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    document: {
      getElementById: () => null,
      addEventListener: (name, handler) => documentEvents.set(name, handler),
    },
    window: {
      location: { origin: 'http://127.0.0.1:3456' },
      crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
      addEventListener: (name, handler) => windowEvents.set(name, handler),
    },
  });
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'state-sync.js'),
    'utf8',
  );
  vm.runInContext(source, context, { filename: 'state-sync.js' });
  return { context, values, windowEvents, documentEvents };
}

function evaluate(context, source) {
  return vm.runInContext(source, context);
}

test('unsaved changes are persisted with their server baseline', () => {
  const { context, values } = createFrontendContext();
  evaluate(context, `
    lastServerData = { schedules: { w1: { g1: {} } } };
    data = { schedules: { w1: { g1: { p1_2026_08_03: [{ note: '草稿' }] } } } };
    pendingHistoryEntries = [{ id: 'h1', action: 'modify' }];
    writePersistentOutbox();
  `);
  const outbox = JSON.parse(values.get('schedule_outbox_v1'));
  assert.equal(outbox.version, 1);
  assert.equal(outbox.draftState.schedules.w1.g1.p1_2026_08_03[0].note, '草稿');
  assert.deepEqual(outbox.historyEntries.map(entry => entry.id), ['h1']);
});

test('reopening merges an unsaved draft with unrelated server changes', () => {
  const { context } = createFrontendContext();
  const result = evaluate(context, `
    (() => {
      const outbox = {
        version: 1,
        baseState: {
          groups: [{ id: 'g1', name: '一组' }],
          schedules: { w1: { g1: {} } }
        },
        draftState: {
          groups: [{ id: 'g1', name: '一组' }],
          schedules: { w1: { g1: { p1_2026_08_03: [{ note: '本机草稿' }] } } }
        },
        historyEntries: []
      };
      restoreOutboxAgainstServer({
        _revision: 9,
        _updated: Date.now(),
        groups: [{ id: 'g1', name: '同事更新的小组名' }],
        schedules: { w1: { g1: {} } }
      }, outbox);
      return {
        groupName: data.groups[0].name,
        note: data.schedules.w1.g1.p1_2026_08_03[0].note,
        requested: syncRequested
      };
    })()
  `);
  assert.equal(result.groupName, '同事更新的小组名');
  assert.equal(result.note, '本机草稿');
  assert.equal(result.requested, true);
});

test('declining a restored conflict adopts the server and clears the outbox', () => {
  const { context, values } = createFrontendContext(false);
  values.set('schedule_outbox_v1', '{"version":1}');
  const result = evaluate(context, `
    (() => {
      const outbox = {
        version: 1,
        baseState: { groups: [{ id: 'g1', name: '原名称' }] },
        draftState: { groups: [{ id: 'g1', name: '我的名称' }] },
        historyEntries: [{ id: 'h1' }]
      };
      restoreOutboxAgainstServer({
        _revision: 10,
        _updated: Date.now(),
        groups: [{ id: 'g1', name: '同事名称' }]
      }, outbox);
      return { name: data.groups[0].name, history: pendingHistoryEntries.length };
    })()
  `);
  assert.equal(result.name, '同事名称');
  assert.equal(result.history, 0);
  assert.equal(values.has('schedule_outbox_v1'), false);
});

test('beforeunload warns only while work is pending', () => {
  const { context, windowEvents } = createFrontendContext();
  const handler = windowEvents.get('beforeunload');
  assert.equal(typeof handler, 'function');

  const cleanEvent = { preventDefault() { this.prevented = true; } };
  handler(cleanEvent);
  assert.equal(cleanEvent.prevented, undefined);

  evaluate(context, `
    lastServerData = { schedules: {} };
    data = { schedules: { w1: {} } };
    writePersistentOutbox();
  `);
  const dirtyEvent = { preventDefault() { this.prevented = true; } };
  handler(dirtyEvent);
  assert.equal(dirtyEvent.prevented, true);
  assert.equal(dirtyEvent.returnValue, '');
});
