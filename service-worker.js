const CACHE_NAME = "punchclock-v12";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./data/shifts.js",
  "./data/payRules.js",
  "./data/cloud.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/splash.jpg",
  "./icons/luba-mascot.jpg",
  "./icons/menny-mascot.jpg",
  "./icons/luba-face.jpg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // {cache: "reload"} bypasses the browser's normal HTTP cache so a fresh
      // deploy is never masked by GitHub Pages' Cache-Control: max-age=600.
      .then((cache) => Promise.all(APP_SHELL.map((url) => fetch(url, { cache: "reload" }).then((res) => cache.put(url, res)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for our own app shell: always prefer the live version while
// online (so updates show up immediately), and only fall back to the cached
// copy when there's no connection at all. Anything cross-origin is untouched.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;

  event.respondWith(
    // {cache: "reload"} here too — without it, this "network-first" fetch can still
    // be silently answered by the browser's own HTTP cache within GitHub Pages'
    // 10-minute Cache-Control window, serving stale content despite our own logic.
    fetch(event.request, { cache: "reload" })
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
