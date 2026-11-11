import {
  SYNC_TABLES,
  addOutbox,
  clearOutbox,
  exportAll,
  getAllEntries,
  getAllFoodComponents,
  getAllFoods,
  getAllWeights,
  getTargets,
  listOutbox,
  loadCategories,
  loadDistribution,
  removeOutbox,
  replaceAll,
  replaceStore,
  saveCategories,
  saveDistribution,
  validateImport,
  withSilentWrites,
} from "./db.js";

const SYNC_KEY = "foodlog.sync";

function emptyCursors() {
  const cursors = {};
  for (const table of SYNC_TABLES) cursors[table] = 0;
  return cursors;
}

export function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (raw == null) return defaultSyncConfig();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultSyncConfig();
    return {
      enabled: Boolean(parsed.enabled),
      url: typeof parsed.url === "string" ? parsed.url.trim().replace(/\/+$/, "") : "",
      secret: typeof parsed.secret === "string" ? parsed.secret : "",
      cursors: { ...emptyCursors(), ...(parsed.cursors && typeof parsed.cursors === "object" ? parsed.cursors : {}) },
      lastSyncAt: typeof parsed.lastSyncAt === "number" ? parsed.lastSyncAt : null,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : "",
    };
  } catch {
    return defaultSyncConfig();
  }
}

function defaultSyncConfig() {
  return { enabled: false, url: "", secret: "", cursors: emptyCursors(), lastSyncAt: null, lastError: "" };
}

export function saveSyncConfig(next) {
  const clean = {
    enabled: Boolean(next.enabled),
    url: String(next.url || "")
      .trim()
      .replace(/\/+$/, ""),
    secret: String(next.secret || ""),
    cursors: { ...emptyCursors(), ...(next.cursors || {}) },
    lastSyncAt: next.lastSyncAt ?? null,
    lastError: next.lastError || "",
  };
  localStorage.setItem(SYNC_KEY, JSON.stringify(clean));
  return clean;
}

export function syncEnabled() {
  const cfg = loadSyncConfig();
  return cfg.enabled && cfg.url !== "" && cfg.secret !== "";
}

let syncTimer = 0;
let syncing = false;

export function noteLocalWrite(change) {
  if (!syncEnabled()) return Promise.resolve();
  const table = change.table;
  if (!SYNC_TABLES.includes(table)) return Promise.resolve();

  const entry = {
    id: crypto.randomUUID(),
    table,
    op: change.op,
    rowId: change.id || table,
    doc: change.doc ?? null,
    createdAt: Date.now(),
  };

  if (change.op === "replaceAll" || change.op === "touch") {
    entry.op = change.op === "touch" ? "touch" : "replaceAll";
  }

  return coalesceOutbox(entry).then(() => scheduleSync());
}

async function coalesceOutbox(entry) {
  if (entry.op !== "replaceAll") {
    await addOutbox(entry);
    return;
  }
  const pending = await listOutbox();
  for (const row of pending) {
    if (row.table === entry.table && row.op === "replaceAll") await removeOutbox(row.id);
  }
  await addOutbox(entry);
}

function scheduleSync() {
  if (!syncEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncNow().catch(() => {});
  }, 1500);
}

export async function pendingCount() {
  const rows = await listOutbox();
  return rows.length;
}

export async function syncNow() {
  if (!syncEnabled() || syncing) return { ok: false, skipped: true };
  if (!navigator.onLine) {
    rememberError("Offline — changes stay queued.");
    return { ok: false, offline: true };
  }
  syncing = true;
  try {
    await flushOutbox();
    await pullDirtyTables();
    const cfg = loadSyncConfig();
    saveSyncConfig({ ...cfg, lastSyncAt: Date.now(), lastError: "" });
    return { ok: true };
  } catch (error) {
    rememberError(error.message || "Sync failed.");
    return { ok: false, error };
  } finally {
    syncing = false;
  }
}

function rememberError(message) {
  const cfg = loadSyncConfig();
  saveSyncConfig({ ...cfg, lastError: message });
}

async function flushOutbox() {
  const pending = (await listOutbox()).slice().sort((a, b) => a.createdAt - b.createdAt);
  for (const item of pending) {
    await pushItem(item);
    await removeOutbox(item.id);
  }
}

async function pushItem(item) {
  const cfg = loadSyncConfig();
  if (item.op === "replaceAll") {
    const docs = await localTableDocs(item.table);
    await api(cfg, "PUT", `/v1/${encodeURIComponent(item.table)}`, docs, item.id);
    return;
  }
  if (item.op === "touch") {
    const doc = await localRow(item.table, item.rowId);
    if (!doc) return;
    await api(cfg, "PUT", `/v1/${encodeURIComponent(item.table)}/${encodeURIComponent(item.rowId)}`, doc, item.id);
    return;
  }
  if (item.op === "delete") {
    await api(cfg, "DELETE", `/v1/${encodeURIComponent(item.table)}/${encodeURIComponent(item.rowId)}`, null, item.id);
    return;
  }
  if (item.op === "put") {
    let doc = item.doc;
    if (!doc) doc = await localRow(item.table, item.rowId);
    if (!doc) return;
    const id = rowIdFor(item.table, doc);
    await api(cfg, "PUT", `/v1/${encodeURIComponent(item.table)}/${encodeURIComponent(id)}`, doc, item.id);
  }
}

async function pullDirtyTables() {
  const cfg = loadSyncConfig();
  const meta = await api(cfg, "GET", "/v1/meta");
  const nextCursors = { ...cfg.cursors };
  for (const table of SYNC_TABLES) {
    const remote = Number(meta[table] || 0);
    const local = Number(cfg.cursors[table] || 0);
    if (remote <= local) continue;
    const docs = await api(cfg, "GET", `/v1/${encodeURIComponent(table)}`);
    await applyRemoteTable(table, docs);
    nextCursors[table] = remote;
  }
  saveSyncConfig({ ...loadSyncConfig(), cursors: nextCursors });
}

async function applyRemoteTable(table, docs) {
  if (!Array.isArray(docs)) throw new Error(`Bad payload for ${table}`);
  await withSilentWrites(async () => {
    if (table === "categories") {
      if (docs.length) saveCategories(docs);
      return;
    }
    if (table === "distribution") {
      if (docs[0]) saveDistribution(docs[0]);
      return;
    }
    await replaceStore(table, docs);
  });
}

async function localTableDocs(table) {
  if (table === "categories") return loadCategories();
  if (table === "distribution") {
    const dist = loadDistribution();
    return dist ? [dist] : [];
  }
  if (table === "foods") return getAllFoods();
  if (table === "foodComponents") return getAllFoodComponents();
  if (table === "entries") return getAllEntries();
  if (table === "targets") return getTargets();
  if (table === "weights") return getAllWeights();
  return [];
}

async function localRow(table, id) {
  const rows = await localTableDocs(table);
  return rows.find((row) => rowIdFor(table, row) === id) || null;
}

function rowIdFor(table, doc) {
  if (table === "distribution") return "distribution";
  if (table === "targets") return doc.effectiveDate;
  if (table === "weights") return doc.dateKey;
  return doc.id;
}

export async function uploadLocalToServer() {
  if (!syncEnabled()) throw new Error("Turn on sync and save the URL and secret first.");
  const dump = await exportAll();
  const cfg = loadSyncConfig();
  await api(cfg, "PUT", "/v1/dump", dump);
  const meta = await api(cfg, "GET", "/v1/meta");
  const cursors = emptyCursors();
  for (const table of SYNC_TABLES) cursors[table] = Number(meta[table] || 0);
  await clearOutbox();
  saveSyncConfig({ ...cfg, cursors, lastSyncAt: Date.now(), lastError: "" });
}

export async function downloadServerToLocal() {
  if (!syncEnabled()) throw new Error("Turn on sync and save the URL and secret first.");
  const cfg = loadSyncConfig();
  const dump = await api(cfg, "GET", "/v1/dump");
  const payload = {
    schemaVersion: 3,
    foods: dump.foods || [],
    foodComponents: dump.foodComponents || [],
    entries: dump.entries || [],
    targets: dump.targets || [],
    weights: dump.weights || [],
  };
  if (Array.isArray(dump.categories) && dump.categories.length) payload.categories = dump.categories;
  if (Array.isArray(dump.distribution) && dump.distribution[0]) payload.distribution = dump.distribution[0];
  else if (dump.distribution && !Array.isArray(dump.distribution)) payload.distribution = dump.distribution;
  const clean = validateImport(payload);
  await withSilentWrites(() => replaceAll(clean));
  await clearOutbox();
  const cursors = emptyCursors();
  const meta = dump.meta || (await api(cfg, "GET", "/v1/meta"));
  for (const table of SYNC_TABLES) cursors[table] = Number(meta[table] || 0);
  saveSyncConfig({ ...loadSyncConfig(), cursors, lastSyncAt: Date.now(), lastError: "" });
}

async function api(cfg, method, path, body, mutationId) {
  const headers = { Authorization: `Bearer ${cfg.secret}` };
  if (mutationId) headers["X-Client-Mutation-Id"] = mutationId;
  let payload;
  if (body !== undefined && body !== null && method !== "GET" && method !== "DELETE") {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${cfg.url}${path}`, { method, headers, body: payload });
  if (response.status === 204) return null;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Sync HTTP ${response.status}`);
  }
  if (!text) return null;
  return JSON.parse(text);
}

export function bindSyncLifecycle(onStatus) {
  const ping = () => {
    if (!syncEnabled()) return;
    syncNow()
      .then(() => onStatus?.())
      .catch(() => onStatus?.());
  };
  window.addEventListener("online", ping);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ping();
  });
  return ping;
}
