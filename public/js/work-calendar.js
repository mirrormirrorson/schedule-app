// 2026 年中国大陆工作日/休息日规则。
// 普通日期按周一至周五为工作日、周六周日为休息日；国务院调休安排覆盖普通规则。
(function initWorkCalendar(global) {
  const OFFICIAL_2026 = {
    '2026-01-01': ['rest', '元旦'], '2026-01-02': ['rest', '元旦'], '2026-01-03': ['rest', '元旦'],
    '2026-01-04': ['work', '元旦调休'],
    '2026-02-14': ['work', '春节调休'],
    '2026-02-15': ['rest', '春节'], '2026-02-16': ['rest', '春节'], '2026-02-17': ['rest', '春节'],
    '2026-02-18': ['rest', '春节'], '2026-02-19': ['rest', '春节'], '2026-02-20': ['rest', '春节'],
    '2026-02-21': ['rest', '春节'], '2026-02-22': ['rest', '春节'], '2026-02-23': ['rest', '春节'],
    '2026-02-28': ['work', '春节调休'],
    '2026-04-04': ['rest', '清明节'], '2026-04-05': ['rest', '清明节'], '2026-04-06': ['rest', '清明节'],
    '2026-05-01': ['rest', '劳动节'], '2026-05-02': ['rest', '劳动节'], '2026-05-03': ['rest', '劳动节'],
    '2026-05-04': ['rest', '劳动节'], '2026-05-05': ['rest', '劳动节'], '2026-05-09': ['work', '劳动节调休'],
    '2026-06-19': ['rest', '端午节'], '2026-06-20': ['rest', '端午节'], '2026-06-21': ['rest', '端午节'],
    '2026-09-20': ['work', '国庆节调休'],
    '2026-09-25': ['rest', '中秋节'], '2026-09-26': ['rest', '中秋节'], '2026-09-27': ['rest', '中秋节'],
    '2026-10-01': ['rest', '国庆节'], '2026-10-02': ['rest', '国庆节'], '2026-10-03': ['rest', '国庆节'],
    '2026-10-04': ['rest', '国庆节'], '2026-10-05': ['rest', '国庆节'], '2026-10-06': ['rest', '国庆节'],
    '2026-10-07': ['rest', '国庆节'], '2026-10-10': ['work', '国庆节调休'],
  };

  function dateKey(input) {
    if (typeof input === 'string') return input.slice(0, 10);
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function getDayInfo(input) {
    const key = dateKey(input);
    const date = typeof input === 'string' ? new Date(`${key}T00:00:00`) : new Date(input);
    if (!key || Number.isNaN(date.getTime())) return { date: key, kind: 'work', mark: '班', name: '', adjusted: false, official: false };
    const official = OFFICIAL_2026[key];
    if (official) {
      return { date: key, kind: official[0], mark: official[0] === 'work' ? '班' : '休', name: official[1], adjusted: official[0] === 'work', official: true };
    }
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    return { date: key, kind: weekend ? 'rest' : 'work', mark: weekend ? '休' : '班', name: '', adjusted: false, official: false };
  }

  global.WorkCalendar = { getDayInfo, OFFICIAL_2026 };
})(window);
