import { localDateKey, todayKey } from "./dates.js";

const DB_NAME = "foodlog";
const DB_VERSION = 1;
export const SCHEMA_VERSION = 1;

let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("foods")) {
          const foods = db.createObjectStore("foods", { keyPath: "id" });
          foods.createIndex("lastUsedAt", "lastUsedAt");
        }
        if (!db.objectStoreNames.contains("entries")) {
          const entries = db.createObjectStore("entries", { keyPath: "id" });
          entries.createIndex("dateKey", "dateKey");
        }
        if (!db.objectStoreNames.contains("targets")) {
          db.createObjectStore("targets", { keyPath: "effectiveDate" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
    });
  }
  return dbPromise;
}

function finish(tx, value) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("The save was aborted."));
  });
}

function readAll(storeName) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export function getAllFoods() {
  return readAll("foods");
}

export function getTargets() {
  return readAll("targets");
}

export function getAllEntries() {
  return readAll("entries");
}

export function getRecentFoods(limit = 10) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("foods", "readonly");
        const request = tx.objectStore("foods").index("lastUsedAt").openCursor(IDBKeyRange.lowerBound(0), "prev");
        const foods = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || foods.length >= limit) {
            resolve(foods);
            return;
          }
          foods.push(cursor.value);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      }),
  );
}

export function getEntriesByDate(dateKey) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("entries", "readonly");
        const request = tx.objectStore("entries").index("dateKey").getAll(dateKey);
        request.onsuccess = () => {
          const rows = request.result;
          rows.sort((a, b) => a.timestamp - b.timestamp || String(a.id).localeCompare(String(b.id)));
          resolve(rows);
        };
        request.onerror = () => reject(request.error);
      }),
  );
}

export function saveFood({ id, name, calories }) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("foods", "readwrite");
        const store = tx.objectStore("foods");
        const now = Date.now();
        let food = null;
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        if (!id) {
          food = {
            id: crypto.randomUUID(),
            name,
            calories,
            lastUsedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          store.put(food);
        } else {
          const getRequest = store.get(id);
          getRequest.onsuccess = () => {
            const row = getRequest.result;
            if (!row) {
              fail(new Error("Food not found."));
              tx.abort();
              return;
            }
            row.name = name;
            row.calories = calories;
            row.updatedAt = now;
            food = row;
            store.put(row);
          };
        }
        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve(food);
        };
        tx.onerror = () => fail(tx.error);
        tx.onabort = () => fail(tx.error || new Error("The save was aborted."));
      }),
  );
}

export function deleteFood(id) {
  return openDb().then((db) => {
    const tx = db.transaction("foods", "readwrite");
    tx.objectStore("foods").delete(id);
    return finish(tx);
  });
}

export function addEntry(food, timestamp = Date.now()) {
  const entry = {
    id: crypto.randomUUID(),
    foodId: food.id ?? null,
    name: food.name,
    calories: food.calories,
    timestamp,
    dateKey: localDateKey(new Date(timestamp)),
  };
  return openDb().then((db) => {
    const tx = db.transaction(["entries", "foods"], "readwrite");
    tx.objectStore("entries").put(entry);
    if (food.id) {
      const foods = tx.objectStore("foods");
      const getRequest = foods.get(food.id);
      getRequest.onsuccess = () => {
        const row = getRequest.result;
        if (!row) return;
        row.lastUsedAt = Math.max(row.lastUsedAt || 0, timestamp);
        row.updatedAt = timestamp;
        foods.put(row);
      };
    }
    return finish(tx, entry);
  });
}

export function deleteEntry(id) {
  return openDb().then((db) => {
    const tx = db.transaction("entries", "readwrite");
    tx.objectStore("entries").delete(id);
    return finish(tx);
  });
}

export function putEntry(entry) {
  return openDb().then((db) => {
    const tx = db.transaction("entries", "readwrite");
    tx.objectStore("entries").put(entry);
    return finish(tx, entry);
  });
}

export function setTarget(effectiveDate, calories) {
  return openDb().then((db) => {
    const tx = db.transaction("targets", "readwrite");
    tx.objectStore("targets").put({ effectiveDate, calories });
    return finish(tx);
  });
}

export async function ensureDefaultTarget(dateKey = todayKey()) {
  const targets = await getTargets();
  if (targets.length > 0) return targets;
  await setTarget(dateKey, 2000);
  return [{ effectiveDate: dateKey, calories: 2000 }];
}

export function exportAll() {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(["foods", "entries", "targets"], "readonly");
        const result = {
          schemaVersion: SCHEMA_VERSION,
          exportedAt: new Date().toISOString(),
          foods: null,
          entries: null,
          targets: null,
        };
        let pending = 3;
        for (const name of ["foods", "entries", "targets"]) {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => {
            result[name] = request.result;
            pending -= 1;
            if (pending === 0) resolve(result);
          };
          request.onerror = () => reject(request.error);
        }
      }),
  );
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function fail(message) {
  throw new Error(message);
}

function isDateKey(value) {
  if (typeof value !== "string" || !DATE_KEY.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function isPositiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && Number.isSafeInteger(value);
}

function isTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parsePositiveInt(raw) {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  const canonical = text.replace(/^0+/, "");
  if (String(value) !== canonical) return null;
  return value;
}

function requireUnique(items, keyFn, label) {
  const seen = new Set();
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) fail(`The backup has a duplicate ${label}.`);
    seen.add(key);
  }
}

function copyFood(raw, index) {
  if (!raw || typeof raw !== "object") fail(`Food ${index} is not an object.`);
  if (typeof raw.id !== "string" || raw.id.trim() === "") fail(`Food ${index} is missing an id.`);
  if (typeof raw.name !== "string" || raw.name.trim() === "") fail(`Food ${index} is missing a name.`);
  if (!isPositiveInt(raw.calories)) fail(`Food ${index} has an invalid calorie value.`);
  let lastUsedAt = null;
  if (raw.lastUsedAt != null) {
    if (!isTimestamp(raw.lastUsedAt)) fail(`Food ${index} has an invalid last-used time.`);
    lastUsedAt = raw.lastUsedAt;
  }
  const now = Date.now();
  const createdAt = raw.createdAt == null ? now : raw.createdAt;
  const updatedAt = raw.updatedAt == null ? now : raw.updatedAt;
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) fail(`Food ${index} has an invalid timestamp.`);
  return {
    id: raw.id,
    name: raw.name.trim(),
    calories: raw.calories,
    lastUsedAt,
    createdAt,
    updatedAt,
  };
}

function copyEntry(raw, index) {
  if (!raw || typeof raw !== "object") fail(`Entry ${index} is not an object.`);
  if (typeof raw.id !== "string" || raw.id.trim() === "") fail(`Entry ${index} is missing an id.`);
  if (typeof raw.name !== "string" || raw.name.trim() === "") fail(`Entry ${index} is missing a name.`);
  if (!isPositiveInt(raw.calories)) fail(`Entry ${index} has an invalid calorie value.`);
  if (!isTimestamp(raw.timestamp)) fail(`Entry ${index} has an invalid time.`);
  if (raw.foodId != null && typeof raw.foodId !== "string") fail(`Entry ${index} has an invalid food id.`);
  const dateKey = raw.dateKey == null ? localDateKey(new Date(raw.timestamp)) : raw.dateKey;
  if (!isDateKey(dateKey)) fail(`Entry ${index} has an invalid date.`);
  return {
    id: raw.id,
    foodId: raw.foodId ?? null,
    name: raw.name.trim(),
    calories: raw.calories,
    timestamp: raw.timestamp,
    dateKey,
  };
}

function copyTarget(raw, index) {
  if (!raw || typeof raw !== "object") fail(`Calorie target ${index} is not an object.`);
  if (!isDateKey(raw.effectiveDate)) fail(`Calorie target ${index} has an invalid date.`);
  if (!isPositiveInt(raw.calories)) fail(`Calorie target ${index} has an invalid calorie value.`);
  return { effectiveDate: raw.effectiveDate, calories: raw.calories };
}

export function validateImport(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("That file is not a backup.");
  if (data.schemaVersion !== SCHEMA_VERSION) fail("This backup version is not supported.");
  if (!Array.isArray(data.foods) || !Array.isArray(data.entries) || !Array.isArray(data.targets)) {
    fail("The backup is missing foods, entries, or targets.");
  }
  const foods = data.foods.map((raw, index) => copyFood(raw, index + 1));
  const entries = data.entries.map((raw, index) => copyEntry(raw, index + 1));
  const targets = data.targets.map((raw, index) => copyTarget(raw, index + 1));
  requireUnique(foods, (food) => food.id, "food");
  requireUnique(entries, (entry) => entry.id, "entry");
  requireUnique(targets, (target) => target.effectiveDate, "calorie target");
  return { foods, entries, targets };
}

export function replaceAll(data) {
  return openDb().then((db) => {
    const tx = db.transaction(["foods", "entries", "targets"], "readwrite");
    const foods = tx.objectStore("foods");
    const entries = tx.objectStore("entries");
    const targets = tx.objectStore("targets");
    foods.clear();
    entries.clear();
    targets.clear();
    for (const food of data.foods) foods.put(food);
    for (const entry of data.entries) entries.put(entry);
    for (const target of data.targets) targets.put(target);
    return finish(tx);
  });
}
