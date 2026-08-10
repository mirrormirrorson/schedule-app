const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMask,
  buildPastePlan,
  selectedSourceCount,
  serializeClipboardText,
  clipboardTextMatches,
} = require('../public/js/grid-clipboard');

function resolveWithin(rows, cols) {
  return (r, c) => (r >= 0 && r < rows && c >= 0 && c < cols ? { r, c } : null);
}

test('Ctrl-selected cells keep a sparse source mask', () => {
  const mask = buildMask(2, 3, [{ r: 4, c: 1 }, { r: 5, c: 3 }], 4, 1);
  assert.deepEqual(mask, [
    [true, false, false],
    [false, false, true],
  ]);
  assert.equal(selectedSourceCount({ rows: 2, cols: 3, mask }), 2);
});

test('pasting a multi-cell copy on one destination expands from that anchor', () => {
  const clip = {
    rows: 2,
    cols: 3,
    mask: [
      [true, false, false],
      [false, false, true],
    ],
  };
  const plan = buildPastePlan([{ r: 1, c: 2 }], clip, resolveWithin(8, 7));
  assert.deepEqual(plan, [
    { cell: { r: 1, c: 2 }, sr: 0, sc: 0 },
    { cell: { r: 2, c: 4 }, sr: 1, sc: 2 },
  ]);
});

test('a vertical internal copy still matches after Windows converts LF to CRLF', () => {
  const clip = {
    rows: 2,
    cols: 1,
    data: [['1'], ['2']],
    mask: [[true], [true]],
  };
  assert.equal(serializeClipboardText(clip), '1\n2');
  assert.equal(clipboardTextMatches(clip, '1\r\n2'), true);
});

test('a rectangular clipboard from outside the app expands every source cell', () => {
  const clip = { rows: 2, cols: 2 };
  const plan = buildPastePlan([{ r: 3, c: 1 }], clip, resolveWithin(8, 7));
  assert.deepEqual(plan.map(({ cell, sr, sc }) => [cell.r, cell.c, sr, sc]), [
    [3, 1, 0, 0],
    [3, 2, 0, 1],
    [4, 1, 1, 0],
    [4, 2, 1, 1],
  ]);
});

test('expanded paste safely clips cells outside the table', () => {
  const clip = { rows: 2, cols: 3 };
  const plan = buildPastePlan([{ r: 7, c: 5 }], clip, resolveWithin(8, 7));
  assert.deepEqual(plan.map(({ cell }) => cell), [
    { r: 7, c: 5 },
    { r: 7, c: 6 },
  ]);
});

test('an explicit target selection still repeats the copied grid', () => {
  const clip = { rows: 1, cols: 2 };
  const targets = [
    { r: 2, c: 1 }, { r: 2, c: 2 },
    { r: 3, c: 1 }, { r: 3, c: 2 },
  ];
  const plan = buildPastePlan(targets, clip, resolveWithin(8, 7));
  assert.deepEqual(plan.map(({ sr, sc }) => [sr, sc]), [
    [0, 0], [0, 1], [0, 0], [0, 1],
  ]);
});
