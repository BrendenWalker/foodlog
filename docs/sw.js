// Bump this name when the shell files change.
const CACHE = "foodlog-shell-v21";

// Shell only. IndexedDB is not cached here.
// iOS may drop this worker after a long stretch of not opening the app; the next online open reinstalls it.
const ASSETS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/app.js",
  "./js/db.js",
  "./js/dates.js",
  "./js/weight.js",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(ASSETS.map((path) => cacheShell(cache, path)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(event.request));
});

async function cacheShell(cache, path) {
  const response = await fetch(new Request(path, { cache: "reload" }));
  if (!response.ok) throw new Error(`Could not cache ${path}`);
  await cache.put(path, await unpacked(response));
}

// Network first, so an installed app picks up a published shell instead of
// keeping the copy from the day it was installed. Offline falls back to cache.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    // A navigation Request cannot be copied with RequestInit, so fetch the URL.
    const response = await fetch(request.url, { cache: "reload", credentials: "same-origin" });
    const clean = await unpacked(response);
    if (clean.ok && clean.type === "basic") await cache.put(request.url, clean.clone());
    return clean;
  } catch (error) {
    const cached =
      (await cache.match(request)) ||
      (request.mode === "navigate" && ((await cache.match("./index.html")) || (await cache.match("./"))));
    if (cached) return cached;
    throw error;
  }
}

// cache.put and navigation responses reject a redirected body. Copying it
// clears the flag so a desktop install can keep IndexedDB.
async function unpacked(response) {
  if (!response.redirected) return response;
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
