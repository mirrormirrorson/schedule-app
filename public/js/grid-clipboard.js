(function initGridClipboard(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScheduleGridClipboard = api;
})(typeof window !== 'undefined' ? window : globalThis, function createGridClipboard() {
  function normalizeClipboardText(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  }

  function serializeClipboardText(clip) {
    if (clip.rows === 1 && clip.cols === 1) {
      return normalizeClipboardText((clip.data[0] && clip.data[0][0]) || '').trim();
    }
    return clip.data
      .map(row => row.map(cell => normalizeClipboardText(cell || '').replace(/\n/g, '\u2424')).join('\t'))
      .join('\n');
  }

  function clipboardTextMatches(clip, text) {
    if (!clip || !clip.data || !clip.data.length) return false;
    return normalizeClipboardText(text).trim() === normalizeClipboardText(serializeClipboardText(clip)).trim();
  }

  function buildMask(rows, cols, cells, minR, minC) {
    const mask = Array.from({ length: rows }, () => Array(cols).fill(false));
    cells.forEach(({ r, c }) => {
      const mr = r - minR;
      const mc = c - minC;
      if (mr >= 0 && mr < rows && mc >= 0 && mc < cols) mask[mr][mc] = true;
    });
    return mask;
  }

  function isSourceCellSelected(clip, row, col) {
    if (!clip.mask) return true;
    return Boolean(clip.mask[row] && clip.mask[row][col]);
  }

  function selectedSourceCount(clip) {
    if (!clip.mask) return clip.rows * clip.cols;
    return clip.mask.reduce(
      (total, row) => total + row.filter(Boolean).length,
      0,
    );
  }

  function buildPastePlan(targetCells, clip, resolveCell) {
    if (!targetCells.length || !clip || clip.rows < 1 || clip.cols < 1) return [];

    if (targetCells.length === 1 && selectedSourceCount(clip) > 1) {
      const anchor = targetCells[0];
      const expanded = [];
      for (let sr = 0; sr < clip.rows; sr++) {
        for (let sc = 0; sc < clip.cols; sc++) {
          if (!isSourceCellSelected(clip, sr, sc)) continue;
          const cell = resolveCell(anchor.r + sr, anchor.c + sc);
          if (cell) expanded.push({ cell, sr, sc });
        }
      }
      return expanded;
    }

    const minR = Math.min(...targetCells.map(cell => cell.r));
    const minC = Math.min(...targetCells.map(cell => cell.c));
    return targetCells.map(cell => {
      const sr = (cell.r - minR) % clip.rows;
      const sc = (cell.c - minC) % clip.cols;
      return { cell, sr, sc };
    }).filter(({ sr, sc }) => isSourceCellSelected(clip, sr, sc));
  }

  return {
    buildMask,
    buildPastePlan,
    selectedSourceCount,
    normalizeClipboardText,
    serializeClipboardText,
    clipboardTextMatches,
  };
});
