import { dateFromKey, groupEntriesByDay, targetFor, todayKey } from "./dates.js";
import {
  FOOD_CATEGORIES,
  addEntry,
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
  saveFood,
  setTarget,
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
};

let view = "today";
let foods = [];
let editingId = null;
let selectedDateKey = null;
let undoEntry = null;
let undoTimer = 0;

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
  const tab = name === "day" ? "history" : name === "food-form" ? "library" : name === "select" ? "today" : name;
  for (const button of document.querySelectorAll("[data-tab]")) {
    if (button.dataset.tab === tab) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  $("screen-title").textContent = title || TITLES[name] || "Calories";
  $("back-btn").hidden = !(name === "day" || name === "food-form" || name === "select");
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

function entryRow(entry) {
  const li = el("li", "row entry");
  li.append(
    el("span", "entry-time", formatTime(entry.timestamp)),
    el("span", "entry-name", entry.name),
    el("span", "entry-cal", `${formatNum(entry.calories)} kcal`),
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
  main.append(el("div", "row-name", food.name), el("div", "row-meta", `${formatNum(food.calories)} kcal`));
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

function foodRow(food, onPress, label) {
  const button = el("button", "food-row");
  button.type = "button";
  button.append(el("span", "food-name", food.name), el("span", "food-cal", `${formatNum(food.calories)} kcal`));
  button.setAttribute("aria-label", label);
  button.addEventListener("click", () => onPress(food));
  const li = el("li");
  li.append(button);
  return li;
}

function filteredFoods(query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return foods;
  return foods.filter((food) => food.name.toLowerCase().includes(needle));
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
  const matches = filteredFoods($("select-search").value);
  const nodes = matches.map((food) => foodRow(food, onAdd, `Add ${food.name}`));
  const emptyText = foods.length === 0 ? "No foods yet. Add them in Library." : "No matching foods.";
  setList("select-list", "select-empty", nodes, emptyText);
}

async function renderLibrary() {
  await loadFoods();
  renderLibraryList();
}

async function renderSettings() {
  const targets = await getTargets();
  const current = targetFor(todayKey(), targets);
  const input = $("target-input");
  if (document.activeElement !== input) input.value = current ?? "";
}

async function refresh() {
  if (view === "today") await renderToday();
  else if (view === "history") await renderHistory();
  else if (view === "day") await renderDay();
  else if (view === "library") await renderLibrary();
  else if (view === "select") {
    await loadFoods();
    renderSelectList();
  } else if (view === "settings") await renderSettings();
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
  $("food-calories").value = food ? String(food.calories) : "";
  $("food-category").value = food && CATEGORIES.some((category) => category.id === food.category) ? food.category : "";
  setError("food-name-error", "");
  setError("food-cal-error", "");
  setError("food-category-error", "");
  $("delete-food").hidden = !food;
  show("food-form", food ? "Edit Food" : "Add Food");
  $("food-name").focus();
}

async function onSaveFood(event) {
  event.preventDefault();
  const name = $("food-name").value.trim();
  const calories = parsePositiveInt($("food-calories").value);
  const category = $("food-category").value;
  const nameOk = name.length > 0;
  const caloriesOk = calories != null;
  const categoryOk = CATEGORIES.some((item) => item.id === category);
  setError("food-name-error", nameOk ? "" : "Name is required.");
  setError("food-cal-error", caloriesOk ? "" : "Calories must be a positive whole number.");
  setError("food-category-error", categoryOk ? "" : "Category is required.");
  if (!nameOk || !caloriesOk || !categoryOk) return;
  await saveFood({ id: editingId, name, calories, category });
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
  const calories = parsePositiveInt($("target-input").value);
  if (calories == null) {
    setError("target-error", "Enter a positive whole number.");
    return;
  }
  setError("target-error", "");
  await setTarget(todayKey(), calories);
  $("settings-msg").textContent = "Saved.";
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
    const current = targetFor(todayKey(), targets);
    $("target-input").value = current ?? "";
    setError("target-error", "");
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
  if (view === "day") onTab("history");
  else if (view === "food-form") onTab("library");
  else if (view === "select") onTab("today");
}

function fillCategorySelect() {
  const select = $("food-category");
  for (const category of CATEGORIES) {
    const option = el("option", "", category.label);
    option.value = category.id;
    select.append(option);
  }
}

function bind() {
  fillCategorySelect();
  $("back-btn").addEventListener("click", onBack);
  $("undo-btn").addEventListener("click", onUndo);
  $("add-from-library").addEventListener("click", openSelect);
  $("add-food").addEventListener("click", () => openFoodForm(null));
  $("food-form").addEventListener("submit", onSaveFood);
  $("delete-food").addEventListener("click", onDeleteFood);
  $("target-form").addEventListener("submit", onSaveTarget);
  $("export-btn").addEventListener("click", onExport);
  $("import-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", onImportFile);
  $("library-search").addEventListener("input", renderLibraryList);
  $("select-search").addEventListener("input", renderSelectList);
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", () => onTab(button.dataset.tab));
  }
}

async function init() {
  assertCategoryOrder();
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
