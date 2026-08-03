(async function init() {
  currentWeek = getMonday(new Date());
  await loadData();
  ensureGroupColors();
  updateWeekUI();
  if (weekGroups().length > 0) activeGroupId = weekGroups()[0].id;
  renderAll();
  initCellTooltip();
  initPersonRadarTooltip();
  updateUndoHint();
  await initIdentity();
  initPresence();
  if (hasPendingSync()) requestSync();
  else setSaveStatus('saved');
})();
