const test = require('node:test');
const assert = require('node:assert/strict');
const { applyChanges, normalizeChanges } = require('../server');

function patch(path, before, after) {
  return {
    path,
    before: before === undefined ? { exists: false } : { exists: true, value: before },
    after: after === undefined ? { exists: false } : { exists: true, value: after },
  };
}

test('two stale clients can update different schedule cells without overwriting each other', () => {
  const base = {
    schedules: {
      '2026-08-03': {
        g1: {
          p1_2026_08_03: [{ note: '原内容 A' }],
          p2_2026_08_03: [{ note: '原内容 B' }],
        },
      },
    },
  };
  const clientA = normalizeChanges([
    patch(
      ['schedules', '2026-08-03', 'g1', 'p1_2026_08_03'],
      [{ note: '原内容 A' }],
      [{ note: 'A 的修改' }],
    ),
  ]);
  const clientB = normalizeChanges([
    patch(
      ['schedules', '2026-08-03', 'g1', 'p2_2026_08_03'],
      [{ note: '原内容 B' }],
      [{ note: 'B 的修改' }],
    ),
  ]);

  const afterA = applyChanges(base, clientA);
  assert.equal(afterA.conflicts.length, 0);
  const afterB = applyChanges(afterA.nextData, clientB);
  assert.equal(afterB.conflicts.length, 0);
  assert.equal(afterB.nextData.schedules['2026-08-03'].g1.p1_2026_08_03[0].note, 'A 的修改');
  assert.equal(afterB.nextData.schedules['2026-08-03'].g1.p2_2026_08_03[0].note, 'B 的修改');
});

test('two stale clients updating the same cell produce an explicit conflict', () => {
  const base = {
    schedules: {
      '2026-08-03': {
        g1: {
          p1_2026_08_03: [{ note: '原内容' }],
        },
      },
    },
  };
  const clientA = normalizeChanges([
    patch(
      ['schedules', '2026-08-03', 'g1', 'p1_2026_08_03'],
      [{ note: '原内容' }],
      [{ note: 'A 的修改' }],
    ),
  ]);
  const clientB = normalizeChanges([
    patch(
      ['schedules', '2026-08-03', 'g1', 'p1_2026_08_03'],
      [{ note: '原内容' }],
      [{ note: 'B 的修改' }],
    ),
  ]);

  const afterA = applyChanges(base, clientA);
  const afterB = applyChanges(afterA.nextData, clientB);
  assert.equal(afterB.conflicts.length, 1);
  assert.equal(afterB.nextData.schedules['2026-08-03'].g1.p1_2026_08_03[0].note, 'A 的修改');
});

test('retrying an already-applied patch is idempotent', () => {
  const base = { groups: [{ id: 'g1', name: '一组' }] };
  const changes = normalizeChanges([
    patch(['groups'], [{ id: 'g1', name: '一组' }], [{ id: 'g1', name: '甲组' }]),
  ]);

  const first = applyChanges(base, changes);
  const retry = applyChanges(first.nextData, changes);
  assert.equal(retry.conflicts.length, 0);
  assert.deepEqual(retry.nextData.groups, [{ id: 'g1', name: '甲组' }]);
});

test('prototype-polluting paths are rejected', () => {
  assert.throws(
    () => normalizeChanges([patch(['schedules', '__proto__', 'x'], undefined, 'bad')]),
    /invalid patch path segment/,
  );
});
