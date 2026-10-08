// Offline support: precache the app shell, pose model and WASM so the app works at the gym
// with no signal after the first visit.
const VERSION = 'coachflip-v0.3.1';
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/kb.js', 'js/pose.js', 'js/recorder.js', 'js/render.js', 'js/store.js',
  'js/engine/core.js', 'js/engine/geom.js', 'js/engine/landmarks.js', 'js/engine/kit.js',
  'js/sports/registry.js',
  ...['boxing', 'softball', 'sprinting', 'distance_running', 'soccer', 'jumping', 'kickboxing', 'mma', 'bjj'].flatMap((s) => [`js/sports/${s}/module.js`, `data/${s}.json`]),
  'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/mediapipe/vision_bundle.mjs',
  'vendor/mediapipe/wasm/vision_wasm_internal.js', 'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'models/pose_landmarker_lite.task',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.headers.has('range')) return; // let media range requests go to the network/blob
  const put = (res) => { if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; };
  const heavy = /\/(vendor|models)\//.test(url.pathname);
  // big, versioned assets (model, wasm): cache first. App code/data: network first so updates
  // show up right away, falling back to the cache when the gym has no signal.
  e.respondWith(heavy
    ? caches.match(req).then((hit) => hit || fetch(req).then(put))
    : fetch(req).then(put).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
