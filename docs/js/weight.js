// Trend from WeightBase ReCalc. First logged day copies the weight.
// Each later logged day: previous + 0.1 * (weight - previous).
// A skipped day does not add a step. Weekly loss uses calendar days:
// (olderTrend - newerTrend) / days * 7. Positive means pounds lost.

function utcDay(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(dateKey, days) {
  const date = new Date(utcDay(dateKey));
  date.setUTCDate(date.getUTCDate() + days);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function calendarDaysBetween(earlier, later) {
  return Math.round((utcDay(later) - utcDay(earlier)) / 86400000);
}

export function trendSeries(logs) {
  const sorted = [...logs].sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));
  let trend = null;
  return sorted.map((log) => {
    trend = trend == null ? log.pounds : trend + 0.1 * (log.pounds - trend);
    return { dateKey: log.dateKey, pounds: log.pounds, trend };
  });
}

// Null until some weigh-in is on or before the start of the window.
// The window ends on the latest weigh-in, not on today.
export function weeklyRate(series, windowDays) {
  if (!series.length) return null;
  const end = series[series.length - 1];
  const startKey = addDays(end.dateKey, -windowDays);
  let start = null;
  for (const point of series) {
    if (point.dateKey <= startKey) start = point;
    else break;
  }
  if (!start) return null;
  const days = calendarDaysBetween(start.dateKey, end.dateKey);
  if (days <= 0) return null;
  return ((start.trend - end.trend) / days) * 7;
}

function assert(condition, message) {
  if (!condition) throw new Error(`weight: ${message}`);
}

function assertClose(actual, expected, message) {
  assert(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${message} (${actual})`);
}

function selfCheck() {
  const series = trendSeries([
    { dateKey: "2026-10-03", pounds: 198 },
    { dateKey: "2026-10-01", pounds: 200 },
    { dateKey: "2026-10-02", pounds: 199 },
  ]);
  assert(series.map((point) => point.dateKey).join() === "2026-10-01,2026-10-02,2026-10-03", "sorts by date");
  assertClose(series[0].trend, 200, "first trend is the weight");
  assertClose(series[1].trend, 199.9, "second trend");
  assertClose(series[2].trend, 199.71, "third trend");

  const week = trendSeries([
    { dateKey: "2026-10-01", pounds: 200 },
    { dateKey: "2026-10-08", pounds: 190 },
  ]);
  assertClose(week[1].trend, 199, "seven-day trend step");
  assertClose(weeklyRate(week, 7), 1, "seven-day loss is 1 lb/week");
  assert(weeklyRate(week, 30) === null, "no weigh-in at the start of 30 days");

  const month = trendSeries([
    { dateKey: "2026-01-01", pounds: 200 },
    { dateKey: "2026-01-31", pounds: 190 },
  ]);
  assertClose(month[1].trend, 199, "thirty-day trend step");
  assertClose(weeklyRate(month, 30), 7 / 30, "thirty-day loss scaled to a week");

  const skipped = trendSeries([
    { dateKey: "2026-03-01", pounds: 200 },
    { dateKey: "2026-03-10", pounds: 198 },
  ]);
  assertClose(skipped[1].trend, 199.8, "a gap is still one trend step");
  assertClose(weeklyRate(skipped, 7), (0.2 / 9) * 7, "a gap uses the calendar span");

  const picked = trendSeries([
    { dateKey: "2026-09-01", pounds: 210 },
    { dateKey: "2026-10-01", pounds: 200 },
    { dateKey: "2026-10-08", pounds: 190 },
  ]);
  assertClose(weeklyRate(picked, 7), 1.9, "uses the latest weigh-in on or before the window");
  assert(weeklyRate(trendSeries([{ dateKey: "2026-10-08", pounds: 200 }]), 7) === null, "one weigh-in has no rate");
}

selfCheck();
