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

// Latest trend pounds, or null when there are no weigh-ins.
export function latestTrend(logs) {
  const series = trendSeries(logs);
  return series.length ? series[series.length - 1].trend : null;
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

// Trend delta from first weigh-in to latest. Positive loss means pounds down.
export function totalLoss(series) {
  if (series.length < 2) return null;
  const first = series[0];
  const last = series[series.length - 1];
  const days = calendarDaysBetween(first.dateKey, last.dateKey);
  if (days <= 0) return null;
  return { loss: first.trend - last.trend, days };
}

// weeklyRate is pounds lost (positive = down). Green when loss rate meets or beats the target.
export function rateMeetsTarget(rate, lbPerWeek) {
  if (rate == null || lbPerWeek == null || !Number.isFinite(rate) || !Number.isFinite(lbPerWeek)) {
    return null;
  }
  return rate >= lbPerWeek;
}

// Goal progress from first weigh-in. Achieved on the first trend point that reaches
// the target; relapsed if the trend later crosses back the other way.
export function goalProgress(series, targetPounds) {
  if (!series.length || typeof targetPounds !== "number" || !Number.isFinite(targetPounds)) {
    return { state: "pending", achievedOn: null, days: null };
  }
  const start = series[0];
  if (start.trend === targetPounds) {
    return { state: "achieved", achievedOn: start.dateKey, days: 0 };
  }
  const lossGoal = targetPounds < start.trend;
  let achievedOn = null;
  for (const point of series) {
    const met = lossGoal ? point.trend <= targetPounds : point.trend >= targetPounds;
    if (met) {
      achievedOn = point.dateKey;
      break;
    }
  }
  if (!achievedOn) return { state: "pending", achievedOn: null, days: null };
  const last = series[series.length - 1];
  const held = lossGoal ? last.trend <= targetPounds : last.trend >= targetPounds;
  return {
    state: held ? "achieved" : "relapsed",
    achievedOn,
    days: calendarDaysBetween(start.dateKey, achievedOn),
  };
}

// Progress tab: reached goals (achieved or relapsed) plus the next pending
// milestone for weight loss. Highest pounds first; further pending goals stay hidden.
export function progressGoals(goals, series) {
  const sorted = [...goals].sort((a, b) =>
    a.pounds !== b.pounds ? b.pounds - a.pounds : a.id < b.id ? -1 : 1,
  );
  const visible = [];
  let includePending = true;
  for (const goal of sorted) {
    const state = goalProgress(series, goal.pounds).state;
    if (state === "achieved" || state === "relapsed") {
      visible.push(goal);
    } else if (includePending) {
      visible.push(goal);
      includePending = false;
    }
  }
  return visible;
}

function assert(condition, message) {
  if (!condition) throw new Error(`weight: ${message}`);
}

function assertClose(actual, expected, message) {
  assert(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${message} (${actual})`);
}

function selfCheck() {
  assert(latestTrend([]) === null, "empty logs have no trend");
  assertClose(latestTrend([{ dateKey: "2026-10-08", pounds: 200 }]), 200, "single weigh-in trend");

  const series = trendSeries([
    { dateKey: "2026-10-03", pounds: 198 },
    { dateKey: "2026-10-01", pounds: 200 },
    { dateKey: "2026-10-02", pounds: 199 },
  ]);
  assert(series.map((point) => point.dateKey).join() === "2026-10-01,2026-10-02,2026-10-03", "sorts by date");
  assertClose(series[0].trend, 200, "first trend is the weight");
  assertClose(series[1].trend, 199.9, "second trend");
  assertClose(series[2].trend, 199.71, "third trend");
  assertClose(latestTrend([
    { dateKey: "2026-10-03", pounds: 198 },
    { dateKey: "2026-10-01", pounds: 200 },
    { dateKey: "2026-10-02", pounds: 199 },
  ]), 199.71, "latest trend follows sorted series");

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

  const overall = totalLoss(series);
  assertClose(overall.loss, 0.29, "total trend loss since first weigh-in");
  assert(overall.days === 2, "total span is calendar days");
  assert(totalLoss(trendSeries([{ dateKey: "2026-10-08", pounds: 200 }])) === null, "one weigh-in has no total");

  assert(rateMeetsTarget(1, 1) === true, "exact rate is green");
  assert(rateMeetsTarget(1.2, 1) === true, "faster loss is green");
  assert(rateMeetsTarget(0.4, 1) === false, "slower loss is red");
  assert(rateMeetsTarget(-0.2, 1) === false, "gain is red");
  assert(rateMeetsTarget(null, 1) === null, "missing rate");
  assert(rateMeetsTarget(1, null) === null, "missing target");

  const down = trendSeries([
    { dateKey: "2026-01-01", pounds: 200 },
    { dateKey: "2026-01-08", pounds: 190 },
    { dateKey: "2026-01-15", pounds: 185 },
    { dateKey: "2026-01-22", pounds: 210 },
  ]);
  // trends: 200, 199, 197.6, 198.84 — never reaches 190 as trend
  const pending = goalProgress(down, 190);
  assert(pending.state === "pending", "high target stays pending while trend is above");

  const reach = trendSeries([
    { dateKey: "2026-01-01", pounds: 200 },
    { dateKey: "2026-01-02", pounds: 100 },
  ]);
  // trends: 200, 190
  const hit = goalProgress(reach, 190);
  assert(hit.state === "achieved", "trend reach is achieved");
  assert(hit.achievedOn === "2026-01-02", "achieved on cross day");
  assert(hit.days === 1, "days from first weigh-in");

  const bounce = trendSeries([
    { dateKey: "2026-01-01", pounds: 200 },
    { dateKey: "2026-01-02", pounds: 100 },
    { dateKey: "2026-01-03", pounds: 300 },
  ]);
  // trends: 200, 190, 201
  const lost = goalProgress(bounce, 190);
  assert(lost.state === "relapsed", "crossing back is relapsed");
  assert(lost.achievedOn === "2026-01-02", "keeps first achieve date");

  const already = goalProgress(trendSeries([{ dateKey: "2026-01-01", pounds: 180 }]), 180);
  assert(already.state === "achieved" && already.days === 0, "start at target");

  const ladder = [
    { id: "a", pounds: 190 },
    { id: "b", pounds: 180 },
    { id: "c", pounds: 170 },
  ];
  assert(progressGoals([], reach).length === 0, "no goals stays empty");
  assert(
    progressGoals(ladder, []).map((goal) => goal.pounds).join() === "190",
    "no weigh-ins shows only the next (highest) goal",
  );
  // trends: 200, 190 — 190 achieved, 180 next, 170 hidden
  assert(
    progressGoals(ladder, reach).map((goal) => goal.pounds).join() === "190,180",
    "mid-ladder shows reached plus next pending",
  );
  const done = trendSeries([
    { dateKey: "2026-01-01", pounds: 200 },
    { dateKey: "2026-01-02", pounds: 0 },
    { dateKey: "2026-01-03", pounds: 0 },
  ]);
  // trends: 200, 180, 162 — all three targets reached
  assert(
    progressGoals(ladder, done).map((goal) => goal.pounds).join() === "190,180,170",
    "all reached lists high to low",
  );
  assert(
    progressGoals(ladder, bounce).map((goal) => goal.pounds).join() === "190,180",
    "relapsed still counts as reached; next pending follows",
  );
}

selfCheck();
