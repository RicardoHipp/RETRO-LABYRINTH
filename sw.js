const CACHE_NAME = 'retro-lab-v1';
const ASSETS = [
    './',
    './index.html',
    './css/style.css',
    './js/main.js',
    './js/renderer.js',
    './js/maze-generator.js',
    './js/combat.js',
    './icon-192.png',
    './icon-512.png'
];

// Install Event
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('[SW] Caching assets');
            return cache.addAll(ASSETS);
        })
    );
});

// Fetch Event (Network First mit Cache Fallback)
self.addEventListener('fetch', event => {
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});
