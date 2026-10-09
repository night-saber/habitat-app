/* Habitat — service worker for offline support */
"use strict";

const CACHE_NAME = "habitat-v5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/store.js",
  "./js/i18n.js",
  "./manifest.json",
  "./assets/icon.svg",
  "./assets/favicon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Network-first for external resources
  if (url.origin !== location.origin) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // Network-first for HTML
  if (e.request.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname === "/") {
    e.respondWith(
      fetch(e.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return response;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Network-first for ALL same-origin assets (JS, CSS, images).
  // Serving code cache-first means a deploy stays invisible until the cache
  // version is bumped by hand — the cache is only an offline fallback.
  //
  // The request is revalidated rather than trusted from the browser's HTTP
  // cache: GitHub Pages serves assets with a max-age, so without this a
  // deploy can sit behind a stale HTTP cache even though the service worker
  // is already fetching from the network. Unchanged files still answer 304,
  // so revalidation is cheap.
  const req = (e.request.method === "GET")
    ? new Request(e.request, { cache: "no-cache" })
    : e.request;
  e.respondWith(
    fetch(req).then((response) => {
      if (response && response.ok && e.request.method === "GET") {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
      }
      return response;
    }).catch(() => caches.match(e.request))
  );
});
