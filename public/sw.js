/* ==========================================================================
 * MasterDrinks POS — Service Worker (PWA)
 * ========================================================================== */

const CACHE_NAME = 'masterdrinks-pos-v79';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css?v=79',
  '/app.js?v=79',
  '/rawbt.js?v=79',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/logo_euphoria.png'
];

// 1. Install: Pre-cache core app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('PWA: No se pudieron precargar todos los recursos:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate: Clean old cache versions
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch Strategy
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // APIs y métodos no GET: SIEMPRE directos a la red (sin caché para datos de venta)
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    return;
  }

  // Recursos estáticos: Network-First con fallback a Caché
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Guardar copia fresca en caché
        if (response && response.status === 200 && response.type === 'basic') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Si no hay red, servir desde la caché local
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('Sin conexión', { status: 503, statusText: 'Offline' });
        });
      })
  );
});
