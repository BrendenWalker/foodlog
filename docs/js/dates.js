// Local calendar days. Never bucket meals with toISOString() or a 24-hour slice.

export function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayKey(now = new Date()) {
  return localDateKey(now);
}

export function dateFromKey(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Latest target whose effectiveDate is on or before dateKey. ISO dates sort as strings.
export function targetRecordFor(dateKey, targets) {
  let best = null;
  for (const target of targets) {
    if (target.effectiveDate <= dateKey && (best === null || target.effectiveDate > best.effectiveDate)) {
      best = target;
    }
  }
  return best;
}

// Returns the calorie number, or null when no target applied yet.
export function targetFor(dateKey, targets) {
  const best = targetRecordFor(dateKey, targets);
  return best ? best.calories : null;
}

// ponytail: full scan. Fine for a personal log. Upgrade path: walk the dateKey index if this gets slow.
export function groupEntriesByDay(entries) {
  const days = new Map();
  for (const entry of entries) {
    const dateKey = entry.dateKey || localDateKey(new Date(entry.timestamp));
    let day = days.get(dateKey);
    if (!day) {
      day = { dateKey, consumed: 0, entries: [] };
      days.set(dateKey, day);
    }
    day.consumed += entry.calories;
    day.entries.push(entry);
  }
  for (const day of days.values()) {
    day.entries.sort((a, b) => a.timestamp - b.timestamp || String(a.id).localeCompare(String(b.id)));
  }
  return [...days.values()].sort((a, b) => (a.dateKey < b.dateKey ? 1 : a.dateKey > b.dateKey ? -1 : 0));
}

function assert(condition, message) {
  if (!condition) throw new Error(`dates: ${message}`);
}

function selfCheck() {
  // Constructed in local time, so this holds in every timezone, including across DST.
  const springEarly = new Date(2026, 2, 8, 1, 30);
  const springLate = new Date(2026, 2, 8, 3, 30);
  assert(localDateKey(springEarly) === "2026-03-08", "spring-forward morning");
  assert(localDateKey(springLate) === "2026-03-08", "spring-forward after the gap");
  assert(localDateKey(springEarly) === localDateKey(springLate), "spring-forward is one local day");

  const fallBack = new Date(2026, 10, 1, 1, 30);
  assert(localDateKey(fallBack) === "2026-11-01", "fall-back hour stays on that local day");

  const lateEvening = new Date(2026, 9, 8, 21, 15);
  assert(localDateKey(lateEvening) === "2026-10-08", "evening stays on the local date");

  const targets = [
    { effectiveDate: "2026-10-08", calories: 1800 },
    { effectiveDate: "2026-10-01", calories: 2000 },
  ];
  assert(targetFor("2026-09-30", targets) === null, "before any target");
  assert(targetFor("2026-10-01", targets) === 2000, "on the first target day");
  assert(targetFor("2026-10-07", targets) === 2000, "day before a change");
  assert(targetFor("2026-10-08", targets) === 1800, "change applies that day");
  assert(targetFor("2026-10-09", targets) === 1800, "change carries forward");
  assert(targetRecordFor("2026-10-08", targets).calories === 1800, "record for the change day");

  const grouped = groupEntriesByDay([
    { id: "a", calories: 100, timestamp: new Date(2026, 9, 8, 23, 30).getTime(), dateKey: "2026-10-08" },
    { id: "b", calories: 50, timestamp: new Date(2026, 9, 8, 1, 0).getTime(), dateKey: "2026-10-08" },
    { id: "c", calories: 10, timestamp: 1, dateKey: "2026-10-06" },
  ]);
  assert(grouped.length === 2, "groups by dateKey");
  assert(grouped[0].dateKey === "2026-10-08" && grouped[0].consumed === 150, "newest day first, summed");
  assert(grouped[0].entries[0].id === "b", "entries within a day are chronological");
  assert(grouped[1].dateKey === "2026-10-06", "older day follows");

  const derived = groupEntriesByDay([{ id: "d", calories: 10, timestamp: lateEvening.getTime() }]);
  assert(derived[0].dateKey === "2026-10-08", "missing dateKey falls back to the local day");
}

selfCheck();
