import { dateFromKey, groupEntriesByDay, targetFor, targetRecordFor, todayKey } from "./dates.js";
import {
  ACTIVITY_LEVELS,
  BODY_LIMITS,
  FOOD_CATEGORIES,
  LOSS_RATES,
  activityFactor,
  addEntry,
  calorieFloor,
  dailyTargetCalories,
  deleteEntry,
  deleteFood,
  ensureDefaultTarget,
  exportAll,
  getAllEntries,
  getAllFoods,
  getEntriesByDate,
  getRecentFoods,
  getTargets,
  parsePositiveInt,
  putEntry,
  replaceAll,
  SERVING_MAX,
  saveFood,
  servingText,
  setTarget,
  validProfile,
  validateImport,
} from "./db.js";

const CATEGORIES = FOOD_CATEGORIES.map((id) => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
}));

const TITLES = {
  today: "Today",
  history: "History",
  library: "Library",
  settings: "Settings",
  select: "Add from Library",
  calories: "Calories",
  import: "Import/Export",
};

const PARENT = {
  day: "history",
  "food-form": "library",
  select: "today",
  calories: "settings",
  import: "settings",
};

let view = "today";
let foods = [];
let editingId = null;
let selectedDateKey = null;
let undoEntry = null;
let undoTimer = 0;
let settingsTarget = null;
let settingsTried = false;

const $ = (id) => document.getElementById(id);

function formatNum(value) {
  return Number(value).toLocaleString();
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDayLabel(dateKey, now = new Date()) {
  const date = dateFromKey(dateKey);
  const options =
    date.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return date.toLocaleDateString(undefined, options);
}

function formatDayLong(dateKey) {
  return dateFromKey(dateKey).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function difference(consumed, target) {
  if (target == null) return null;
  if (consumed > target) return { kind: "over", amount: consumed - target };
  if (consumed < target) return { kind: "under", amount: target - consumed };
  return { kind: "even", amount: 0 };
}

function differenceText(consumed, target) {
  const diff = difference(consumed, target);
  if (!diff) return "";
  if (diff.kind === "over") return `${formatNum(diff.amount)} over`;
  if (diff.kind === "under") return `${formatNum(diff.amount)} under`;
  return "on target";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setError(id, message) {
  const node = $(id);
  node.hidden = !message;
  node.textContent = message || "";
}

function setList(listId, emptyId, nodes, emptyText) {
  const list = $(listId);
  const empty = $(emptyId);
  list.replaceChildren(...nodes);
  const isEmpty = nodes.length === 0;
  list.hidden = isEmpty;
  empty.hidden = !isEmpty;
  if (emptyText) empty.textContent = emptyText;
}

function show(name, title) {
  view = name;
  for (const section of document.querySelectorAll("[data-view]")) {
    section.hidden = section.dataset.view !== name;
  }
  const tab = PARENT[name] || name;
  for (const button of document.querySelectorAll("[data-tab]")) {
    if (button.dataset.tab === tab) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  $("screen-title").textContent = title || TITLES[name] || "Calories";
  $("back-btn").hidden = !(name in PARENT);
}

function paintStatus(consumed, target) {
  const main = $("status-main");
  const sub = $("status-sub");
  const bar = $("status-bar");
  const fill = $("status-fill");
  if (target == null) {
    main.textContent = `${formatNum(consumed)} kcal`;
    sub.textContent = "Set a daily target";
    sub.classList.remove("over");
    bar.classList.remove("over");
    fill.style.width = "0%";
    bar.setAttribute("aria-valuemax", "0");
    bar.setAttribute("aria-valuenow", String(consumed));
    bar.setAttribute("aria-valuetext", sub.textContent);
    return;
  }
  main.textContent = `${formatNum(consumed)} / ${formatNum(target)} kcal`;
  const over = consumed > target;
  sub.classList.toggle("over", over);
  bar.classList.toggle("over", over);
  if (over) {
    sub.textContent = `${formatNum(consumed - target)} kcal over`;
    fill.style.width = "100%";
  } else {
    sub.textContent = `${formatNum(target - consumed)} kcal remaining`;
    const pct = Math.min(100, (consumed / target) * 100);
    fill.style.width = `${pct}%`;
  }
  bar.setAttribute("aria-valuemax", String(target));
  bar.setAttribute("aria-valuenow", String(consumed));
  bar.setAttribute("aria-valuetext", sub.textContent);
}

function kcalLabel(item) {
  const kcal = `${formatNum(item.calories)} kcal`;
  const serving = servingText(item);
  return serving ? `(${serving}) ${kcal}` : kcal;
}

function entryRow(entry) {
  const li = el("li", "row entry");
  li.append(
    el("span", "entry-time", formatTime(entry.timestamp)),
    el("span", "entry-name", entry.name),
    el("span", "entry-cal", kcalLabel(entry)),
  );
  const remove = el("button", "remove-btn", "Remove");
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove ${entry.name}`);
  remove.addEventListener("click", () => removeEntry(entry));
  li.append(remove);
  return li;
}

function recentRow(food) {
  const li = el("li", "row");
  const main = el("div", "row-main");
  main.append(el("div", "row-name", food.name), el("div", "row-meta", kcalLabel(food)));
  const add = el("button", "add-btn", "Add");
  add.type = "button";
  add.setAttribute("aria-label", `Add ${food.name}`);
  add.addEventListener("click", () => onAdd(food));
  li.append(main, add);
  return li;
}

function groupFoods(items) {
  const buckets = new Map(CATEGORIES.map((category) => [category.id, []]));
  const uncategorized = [];
  for (const food of items) {
    const bucket = buckets.get(food.category);
    if (bucket) bucket.push(food);
    else uncategorized.push(food);
  }
  const groups = [];
  for (const category of CATEGORIES) {
    const foodsInGroup = buckets.get(category.id);
    if (foodsInGroup.length === 0) continue;
    groups.push({ id: category.id, label: category.label, foods: foodsInGroup });
  }
  if (uncategorized.length > 0) groups.push({ id: "uncategorized", label: "Uncategorized", foods: uncategorized });
  return groups;
}

function assertServingLabel() {
  if (kcalLabel({ calories: 100 }) !== "100 kcal") throw new Error("serving label");
  if (kcalLabel({ calories: 100, serving: "1 cup" }) !== "(1 cup) 100 kcal") throw new Error("serving label");
  if (kcalLabel({ calories: 100, grams: 30 }) !== "(30 g) 100 kcal") throw new Error("serving label");
}

function assertCategoryOrder() {
  const ids = groupFoods([
    { name: "Z", category: "dinner" },
    { name: "A", category: "drink" },
    { name: "M", category: null },
  ])
    .map((group) => group.id)
    .join(",");
  if (ids !== "drink,dinner,uncategorized") throw new Error("category grouping");
}

function assertSelectFilter() {
  const saved = foods;
  foods = [
    { name: "Tea", category: "drink" },
    { name: "Toast", category: "breakfast" },
  ];
  const drinks = filteredFoods("", "drink").map((food) => food.name).join(",");
  const searched = filteredFoods("t", "").map((food) => food.name).join(",");
  const both = filteredFoods("to", "drink").map((food) => food.name).join(",");
  foods = saved;
  if (drinks !== "Tea") throw new Error("category filter");
  if (searched !== "Tea,Toast") throw new Error("search filter");
  if (both !== "") throw new Error("category and search");
}

function foodRow(food, onPress, label) {
  const button = el("button", "food-row");
  button.type = "button";
  button.append(el("span", "food-name", food.name), el("span", "food-cal", kcalLabel(food)));
  button.setAttribute("aria-label", label);
  button.addEventListener("click", () => onPress(food));
  const li = el("li");
  li.append(button);
  return li;
}

function filteredFoods(query, category = "") {
  const needle = query.trim().toLowerCase();
  if (!needle && !category) return foods;
  return foods.filter((food) => {
    if (category && food.category !== category) return false;
    return !needle || food.name.toLowerCase().includes(needle);
  });
}

async function loadFoods() {
  foods = await getAllFoods();
  foods.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

async function renderToday() {
  const dateKey = todayKey();
  const [entries, recent, targets] = await Promise.all([
    getEntriesByDate(dateKey),
    getRecentFoods(10),
    getTargets(),
  ]);
  const consumed = entries.reduce((sum, entry) => sum + entry.calories, 0);
  paintStatus(consumed, targetFor(dateKey, targets));
  setList("recent-list", "recent-empty", recent.map(recentRow), "No recent foods yet.");
  setList("today-entries", "today-empty", entries.map(entryRow), "Nothing logged today.");
  setError("today-error", "");
}

async function renderHistory() {
  const [entries, targets] = await Promise.all([getAllEntries(), getTargets()]);
  const days = groupEntriesByDay(entries);
  const nodes = days.map((day) => {
    const button = el("button", "day-row");
    button.type = "button";
    const copy = el("span", "day-copy");
    const meta = el("span", "day-meta");
    const target = targetFor(day.dateKey, targets);
    const diff = differenceText(day.consumed, target);
    meta.textContent = target == null ? `${formatNum(day.consumed)} kcal` : `${formatNum(day.consumed)} kcal · ${formatNum(target)} target · ${diff}`;
    copy.append(el("span", "day-date", formatDayLabel(day.dateKey)), meta);
    button.append(copy);
    button.addEventListener("click", () => openDay(day.dateKey));
    const li = el("li");
    li.append(button);
    return li;
  });
  setList("history-list", "history-empty", nodes, "No history yet.");
}

async function renderDay() {
  const dateKey = selectedDateKey;
  const [entries, targets] = await Promise.all([getEntriesByDate(dateKey), getTargets()]);
  if (entries.length === 0) {
    show("history");
    await renderHistory();
    return;
  }
  $("day-entries").replaceChildren(...entries.map(entryRow));
  const consumed = entries.reduce((sum, entry) => sum + entry.calories, 0);
  const target = targetFor(dateKey, targets);
  const summary = $("day-summary");
  summary.replaceChildren();
  summary.append(summaryRow("Total", `${formatNum(consumed)} kcal`, true));
  if (target != null) {
    const diff = difference(consumed, target);
    summary.append(summaryRow("Target", `${formatNum(target)} kcal`, false));
    if (diff.kind === "over") summary.append(summaryRow("Over", `${formatNum(diff.amount)} kcal`, false, true));
    else if (diff.kind === "under") summary.append(summaryRow("Under", `${formatNum(diff.amount)} kcal`, false));
    else summary.append(summaryRow("Difference", "On target", false));
  }
}

function summaryRow(label, value, strong, over) {
  const row = el("div", over ? "summary-row over" : "summary-row");
  const tag = strong ? "strong" : "span";
  row.append(el(tag, "", label), el(tag, "", value));
  return row;
}

function renderLibraryList() {
  const matches = filteredFoods($("library-search").value);
  const nodes = groupFoods(matches).flatMap((group) => {
    const list = el("ul", "rows");
    list.append(...group.foods.map((food) => foodRow(food, openFoodForm, `Edit ${food.name}`)));
    return [el("h2", "", group.label), list];
  });
  const emptyText = foods.length === 0 ? "No foods yet." : "No matching foods.";
  setList("library-list", "library-empty", nodes, emptyText);
}

function renderSelectList() {
  const matches = filteredFoods($("select-search").value, $("select-category").value);
  const nodes = matches.map((food) => foodRow(food, onAdd, `Add ${food.name}`));
  const emptyText = foods.length === 0 ? "No foods yet. Add them in Library." : "No matching foods.";
  setList("select-list", "select-empty", nodes, emptyText);
}

function onSelectSearch() {
  if ($("select-search").value !== "") $("select-category").value = "";
  renderSelectList();
}

async function renderLibrary() {
  await loadFoods();
  renderLibraryList();
}

function rateLabel(rate) {
  return rate === 0.5 ? ".5" : String(rate);
}

function fillActivitySelect() {
  const select = $("activity-input");
  for (const level of ACTIVITY_LEVELS) {
    const option = el("option", "", level.label);
    option.value = level.id;
    select.append(option);
  }
}

function fillRateRadios() {
  const row = $("rate-row");
  for (const rate of LOSS_RATES) {
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "lb-per-week";
    input.value = String(rate);
    const label = el("label", "choice");
    label.append(input, rateLabel(rate));
    row.append(label);
  }
}

function checkedValue(name) {
  const node = $("target-form").querySelector(`input[name="${name}"]:checked`);
  return node ? node.value : "";
}

function parseInches(raw) {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (text !== String(value) || value > 11) return null;
  return value;
}

function parseWeightLb(raw) {
  const text = String(raw ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text) || /^0\d/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < BODY_LIMITS.weightMin || value > BODY_LIMITS.weightMax) return null;
  return value;
}

function readProfile() {
  const sex = checkedValue("sex");
  const age = parsePositiveInt($("age-input").value);
  const feet = parsePositiveInt($("height-ft").value);
  const inches = parseInches($("height-in").value);
  const weightLb = parseWeightLb($("weight-input").value);
  const rateRaw = checkedValue("lb-per-week");
  const lbPerWeek = rateRaw && LOSS_RATES.includes(Number(rateRaw)) ? Number(rateRaw) : null;
  const activity = $("activity-input").value;
  const heightIn = feet != null && inches != null ? feet * 12 + inches : null;
  const sexOk = sex === "male" || sex === "female";
  const ageOk = age != null && age >= BODY_LIMITS.ageMin && age <= BODY_LIMITS.ageMax;
  const heightOk =
    heightIn != null && heightIn >= BODY_LIMITS.heightMin && heightIn <= BODY_LIMITS.heightMax && inches <= 11;
  const activityOk = activityFactor(activity) != null;
  const value = { sex, age, heightIn, weightLb, lbPerWeek, activity };
  return {
    ok: sexOk && ageOk && heightOk && weightLb != null && lbPerWeek != null && activityOk && validProfile(value),
    value,
    errors: {
      sex: sexOk ? "" : "Select male or female.",
      age: ageOk ? "" : `Age must be ${BODY_LIMITS.ageMin} to ${BODY_LIMITS.ageMax}.`,
      height: heightOk ? "" : "Height must be 4 ft 0 in to 8 ft 0 in.",
      weight: weightLb != null ? "" : `Weight must be ${BODY_LIMITS.weightMin} to ${BODY_LIMITS.weightMax} lb.`,
      activity: activityOk ? "" : "Select an activity level.",
      rate: lbPerWeek != null ? "" : "Select pounds per week.",
    },
  };
}

function showProfileErrors(errors) {
  setError("sex-error", errors.sex);
  setError("age-error", errors.age);
  setError("height-error", errors.height);
  setError("weight-error", errors.weight);
  setError("activity-error", errors.activity);
  setError("rate-error", errors.rate);
}

function clearProfileErrors() {
  showProfileErrors({ sex: "", age: "", height: "", weight: "", activity: "", rate: "" });
  setError("target-error", "");
}

function fillProfile(record) {
  const sex = record && (record.sex === "male" || record.sex === "female") ? record.sex : "";
  for (const input of $("target-form").querySelectorAll('input[name="sex"]')) {
    input.checked = input.value === sex;
  }
  $("age-input").value = record && Number.isInteger(record.age) ? String(record.age) : "";
  if (record && Number.isInteger(record.heightIn)) {
    $("height-ft").value = String(Math.floor(record.heightIn / 12));
    $("height-in").value = String(record.heightIn % 12);
  } else {
    $("height-ft").value = "";
    $("height-in").value = "";
  }
  $("weight-input").value = record && typeof record.weightLb === "number" ? String(record.weightLb) : "";
  const activity = record && activityFactor(record.activity) != null ? record.activity : "sedentary";
  $("activity-input").value = activity;
  for (const input of $("target-form").querySelectorAll('input[name="lb-per-week"]')) {
    input.checked = record != null && Number(input.value) === record.lbPerWeek;
  }
}

function paintPreview() {
  const profile = readProfile();
  const preview = $("target-preview");
  const hint = $("target-hint");
  if (!profile.ok) {
    const current = settingsTarget && settingsTarget.calories;
    preview.textContent = current ? `Current target: ${formatNum(current)} kcal` : "";
    preview.classList.toggle("is-current", Boolean(current));
    hint.hidden = true;
    setError("target-error", "");
    return;
  }
  const calories = dailyTargetCalories(profile.value);
  const floor = calorieFloor(profile.value.sex);
  preview.textContent = `Eat ${formatNum(calories)} kcal / day`;
  preview.classList.remove("is-current");
  hint.hidden = false;
  setError(
    "target-error",
    calories < floor ? `${formatNum(calories)} kcal is under the ${formatNum(floor)} kcal minimum.` : "",
  );
}

function onProfileInput() {
  setSettingsMsg("");
  if (settingsTried) showProfileErrors(readProfile().errors);
  paintPreview();
}

async function renderSettings() {
  const targets = await getTargets();
  settingsTarget = targetRecordFor(todayKey(), targets);
  if (!$("target-form").contains(document.activeElement)) {
    settingsTried = false;
    fillProfile(settingsTarget);
    clearProfileErrors();
  }
  paintPreview();
}

async function refresh() {
  if (view === "today") await renderToday();
  else if (view === "history") await renderHistory();
  else if (view === "day") await renderDay();
  else if (view === "library") await renderLibrary();
  else if (view === "select") {
    await loadFoods();
    renderSelectList();
  } else if (view === "calories") await renderSettings();
}

function clearUndo() {
  clearTimeout(undoTimer);
  undoEntry = null;
  $("undo").hidden = true;
  document.body.classList.remove("undo-open");
}

function armUndo(entry) {
  undoEntry = entry;
  clearTimeout(undoTimer);
  $("undo-label").textContent = `Removed ${entry.name}`;
  $("undo").hidden = false;
  document.body.classList.add("undo-open");
  undoTimer = setTimeout(clearUndo, 5000);
}

async function removeEntry(entry) {
  await deleteEntry(entry.id);
  armUndo(entry);
  await refresh();
}

async function onUndo() {
  const entry = undoEntry;
  if (!entry) return;
  clearTimeout(undoTimer);
  try {
    await putEntry(entry);
    clearUndo();
    await refresh();
  } catch (error) {
    console.error(error);
    armUndo(entry);
  }
}

async function onQuickAdd(event) {
  event.preventDefault();
  const input = $("quick-calories");
  const calories = parsePositiveInt(input.value);
  if (calories == null) {
    setError("quick-error", "Calories must be a positive whole number.");
    return;
  }
  setError("quick-error", "");
  try {
    await addEntry({ name: "Quick add", calories });
    input.value = "";
    setError("today-error", "");
    await renderToday();
  } catch (error) {
    console.error(error);
    setError("quick-error", "Could not save that entry.");
  }
}

async function onAdd(food) {
  try {
    await addEntry(food);
    setError("today-error", "");
    if (view === "select") show("today");
    await renderToday();
  } catch (error) {
    console.error(error);
    setError("today-error", "Could not save that entry.");
    if (view !== "today" && view !== "select") return;
    if (view === "select") show("today");
  }
}

async function openSelect() {
  await loadFoods();
  $("select-search").value = "";
  $("select-category").value = "";
  show("select");
  renderSelectList();
}

async function openDay(dateKey) {
  selectedDateKey = dateKey;
  show("day", formatDayLong(dateKey));
  await renderDay();
}

function openFoodForm(food) {
  editingId = food ? food.id : null;
  $("food-name").value = food ? food.name : "";
  $("food-serving").value = food ? servingText(food) : "";
  $("food-calories").value = food ? String(food.calories) : "";
  $("food-category").value = food && CATEGORIES.some((category) => category.id === food.category) ? food.category : "";
  setError("food-name-error", "");
  setError("food-serving-error", "");
  setError("food-cal-error", "");
  setError("food-category-error", "");
  $("delete-food").hidden = !food;
  show("food-form", food ? "Edit Food" : "Add Food");
  $("food-name").focus();
}

async function onSaveFood(event) {
  event.preventDefault();
  const name = $("food-name").value.trim();
  const serving = $("food-serving").value.trim();
  const calories = parsePositiveInt($("food-calories").value);
  const category = $("food-category").value;
  const nameOk = name.length > 0;
  const servingOk = serving.length <= SERVING_MAX;
  const caloriesOk = calories != null;
  const categoryOk = CATEGORIES.some((item) => item.id === category);
  setError("food-name-error", nameOk ? "" : "Name is required.");
  setError("food-serving-error", servingOk ? "" : `Serving size must be ${SERVING_MAX} characters or less.`);
  setError("food-cal-error", caloriesOk ? "" : "Calories must be a positive whole number.");
  setError("food-category-error", categoryOk ? "" : "Category is required.");
  if (!nameOk || !servingOk || !caloriesOk || !categoryOk) return;
  await saveFood({ id: editingId, name, calories, category, serving });
  show("library");
  await renderLibrary();
}

async function onDeleteFood() {
  const food = foods.find((item) => item.id === editingId);
  if (!food) return;
  if (!confirm(`Delete ${food.name}? Logged entries will stay.`)) return;
  await deleteFood(food.id);
  show("library");
  await renderLibrary();
}

async function onSaveTarget(event) {
  event.preventDefault();
  settingsTried = true;
  const profile = readProfile();
  showProfileErrors(profile.errors);
  paintPreview();
  if (!profile.ok) return;
  const calories = dailyTargetCalories(profile.value);
  const floor = calorieFloor(profile.value.sex);
  if (calories < floor) return;
  await setTarget(todayKey(), calories, profile.value);
  settingsTarget = { effectiveDate: todayKey(), calories, ...profile.value };
  settingsTried = false;
  setSettingsMsg("Saved.");
}

function setSettingsMsg(message) {
  $("settings-msg").textContent = message;
}

async function onExport() {
  try {
    const data = await exportAll();
    const json = JSON.stringify(data, null, 2);
    const name = `foodlog-${todayKey()}.json`;
    const file = new File([json], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Calorie Tracker backup" });
        setSettingsMsg("Backup ready to share.");
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setSettingsMsg("Backup downloaded.");
  } catch (error) {
    console.error(error);
    setSettingsMsg("Could not export.");
  }
}

async function onImportFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    setSettingsMsg("That file is not valid JSON. Nothing was changed.");
    return;
  }
  let clean;
  try {
    clean = validateImport(parsed);
  } catch (error) {
    setSettingsMsg(`${error.message} Nothing was changed.`);
    return;
  }
  if (!confirm("Replace all current foods, entries, and targets with this backup?")) return;
  try {
    await replaceAll(clean);
    const targets = await ensureDefaultTarget(todayKey());
    settingsTarget = targetRecordFor(todayKey(), targets);
    settingsTried = false;
    fillProfile(settingsTarget);
    clearProfileErrors();
    paintPreview();
    setSettingsMsg("Backup restored.");
  } catch (error) {
    console.error(error);
    setSettingsMsg("Could not restore that backup. Nothing was changed.");
  }
}

async function onTab(name) {
  if (name === "settings") setSettingsMsg("");
  show(name);
  await refresh();
}

function onBack() {
  const parent = PARENT[view];
  if (parent) onTab(parent);
}

function fillCategorySelect() {
  const select = $("food-category");
  const filter = $("select-category");
  for (const category of CATEGORIES) {
    const option = el("option", "", category.label);
    option.value = category.id;
    select.append(option);
    filter.append(option.cloneNode(true));
  }
}

function assertCalorieFormula() {
  const calories = dailyTargetCalories({ sex: "male", age: 40, heightIn: 72, weightLb: 200, lbPerWeek: 1 });
  if (calories !== 1726) throw new Error("calorie formula");
  const active = dailyTargetCalories({
    sex: "male",
    age: 40,
    heightIn: 72,
    weightLb: 200,
    lbPerWeek: 1,
    activity: "moderate",
  });
  if (active !== 2376) throw new Error("calorie activity");
  const low = dailyTargetCalories({ sex: "female", age: 40, heightIn: 60, weightLb: 100, lbPerWeek: 2.5 });
  if (low !== 4) throw new Error("calorie floor fixture");
}

function bind() {
  fillCategorySelect();
  fillActivitySelect();
  fillRateRadios();
  $("back-btn").addEventListener("click", onBack);
  $("undo-btn").addEventListener("click", onUndo);
  $("add-from-library").addEventListener("click", openSelect);
  $("quick-add").addEventListener("submit", onQuickAdd);
  $("add-food").addEventListener("click", () => openFoodForm(null));
  $("food-form").addEventListener("submit", onSaveFood);
  $("delete-food").addEventListener("click", onDeleteFood);
  $("target-form").addEventListener("submit", onSaveTarget);
  $("target-form").addEventListener("input", onProfileInput);
  $("target-form").addEventListener("change", onProfileInput);
  $("export-btn").addEventListener("click", onExport);
  $("import-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", onImportFile);
  $("library-search").addEventListener("input", renderLibraryList);
  $("select-search").addEventListener("input", onSelectSearch);
  $("select-category").addEventListener("change", renderSelectList);
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", () => onTab(button.dataset.tab));
  }
  for (const button of document.querySelectorAll("[data-open]")) {
    button.addEventListener("click", () => onTab(button.dataset.open));
  }
}

async function init() {
  assertCategoryOrder();
  assertSelectFilter();
  assertServingLabel();
  assertCalorieFormula();
  bind();
  await ensureDefaultTarget(todayKey());
  show("today");
  await renderToday();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.error(error));
  }
}

init().catch((error) => {
  console.error(error);
  $("screen-title").textContent = "Could not open saved data";
});
