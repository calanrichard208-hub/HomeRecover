// Offline support: keep the app files on the phone so the last plan opens with no internet.
// Records are not stored here; they live in the app's own storage (see js/store.js).
const CACHE = "homerecover-shell-v2";
const SHELL = ["./", "index.html", "styles.css", "manifest.json", "icon.svg", "icon-192.png", "icon-512.png",
  "js/app.js", "js/store.js", "js/trend.js", "js/i18n.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // Network first so updates arrive, cache as the fallback when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("index.html"))),
  );
});
