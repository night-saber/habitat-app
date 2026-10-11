/* Habitat — service worker for offline support
 *
 * Caching strategy (per PWA best practices):
 *   HTML:   Network First (fresh content, fallback to cache, then offline.html)
 *   Assets: Cache First (versioned via CACHE_NAME bump on deploy)
 *   API:    Network Only (no caching of dynamic data)
 *   CDN:    Cache First with stale fallback (external libs)
 */
"use strict";

const CACHE_NAME = "habitat-v9";
const APP_SHELL = [
  "./",
  "./index.html",
  "./offline.html",
  "./css/style.css",
  "./js/app.js",
  "./js/store.js",
  "./js/i18n.js",
  "./js/version.js",
  "./js/mesh.js",
  "./manifest.webmanifest",
  "./privacy.html",
  "./terms.html",
  "./assets/icon.svg",
  "./assets/favicon.svg",
  "./assets/apple-touch-icon.png",
  "./assets/icon-192x192.png",
  "./assets/icon-512x512.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/three@0.160.0/build/three.module.js",
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

/* Network-only for API requests (never cache dynamic data) */
  if (url.pathname.startsWith("/api/") || url.origin.includes("loca.lt") || url.origin.includes("onrender.com")) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: "Network unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })));
    return;
  }

  /* Cache-first for external CDN resources (Leaflet, Three.js) */
  if (url.origin !== location.origin) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          return response;
        }).catch(() => caches.match(e.request));
      })
    );
    return;
  }

  /* Network-first for HTML (with offline fallback) */
  if (e.request.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname === "/") {
    e.respondWith(
      fetch(e.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return response;
      }).catch(() => {
        return caches.match(e.request).then((cached) => {
          return cached || caches.match("./offline.html");
        });
      })
    );
    return;
  }

  /* Cache-first for static assets (JS, CSS, images, fonts) */
  if (e.request.method === "GET" && (
    url.pathname.startsWith("/js/") ||
    url.pathname.startsWith("/css/") ||
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/manifest") ||
    url.pathname.startsWith("/privacy.html") ||
    url.pathname.startsWith("/terms.html")
  )) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          return response;
        });
      })
    );
    return;
  }

  /* Default: network-first with cache fallback */
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
