/**
 * sw.js — CH Geladas PDV · Service Worker v13
 *
 * ESTRATÉGIA:
 *   assets estáticos locais → cache-first  (shell do app)
 *   páginas HTML            → network-first (sempre tenta atualizar)
 *   CDN externo             → stale-while-revalidate
 *   Firebase / API          → network-only  (nunca cachear)
 *
 * Bumpe CACHE_VERSION a cada deploy para forçar atualização.
 */

const CACHE_VERSION  = 'chg-v13';
const CACHE_STATIC   = `${CACHE_VERSION}-static`;
const CACHE_PAGES    = `${CACHE_VERSION}-pages`;
const CACHE_CDN      = `${CACHE_VERSION}-cdn`;

// Assets que DEVEM estar no cache para o app funcionar offline
const STATIC_ASSETS = [
  './core.js',
  './manifest.json',
  './services/vendasService.js',
  './services/estoqueService.js',
  './services/financeiroService.js',
  './services/aprovacaoService.js',
  './services/biService.js',
  './services/syncService.js',
  './services/syncMonitor.js',
  './services/auditService.js',
  './services/userService.js',
  './services/soundService.js',
  './services/errorPreventionService.js',
  './services/featureFlagsService.js',
  './services/permissoesService.js',
  './services/backupService.js',
  './services/billingService.js',
  './services/saasService.js',
  './services/whitelabelService.js',
  './services/filialService.js',
];

// Páginas HTML — cacheadas mas sempre tenta network primeiro
const PAGE_ASSETS = [
  './index.html',
  './vendas.html',
  './estoque.html',
  './financeiro.html',
  './comanda.html',
  './delivery.html',
  './fiado.html',
  './bi-dashboard.html',
  './monitor.html',
  './ponto.html',
];

// Domínios que nunca devem ser cacheados
const NETWORK_ONLY = [
  'firebaseio.com',
  'googleapis.com',
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
];

// ── Install: pré-cacheia o shell ─────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_STATIC).then(c => c.addAll(STATIC_ASSETS).catch(e => {
        console.warn('[SW] Alguns assets estáticos falharam no pre-cache:', e.message);
      })),
      caches.open(CACHE_PAGES).then(c => c.addAll(PAGE_ASSETS).catch(e => {
        console.warn('[SW] Alguns HTMLs falharam no pre-cache:', e.message);
      })),
    ]).then(() => self.skipWaiting())
  );
});

// ── Activate: remove caches de versões antigas ───────────────────────
self.addEventListener('activate', event => {
  const valid = new Set([CACHE_STATIC, CACHE_PAGES, CACHE_CDN]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !valid.has(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => console.info('[SW] Ativado — versão', CACHE_VERSION))
  );
});

// ── Fetch: roteamento por estratégia ────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Network-only: Firebase e APIs externas
  if (NETWORK_ONLY.some(d => url.hostname.includes(d))) {
    event.respondWith(fetch(request));
    return;
  }

  // 2. Só intercepta GET
  if (request.method !== 'GET') {
    event.respondWith(fetch(request));
    return;
  }

  // 3. Páginas HTML → network-first (tenta baixar nova versão, cai no cache)
  if (request.destination === 'document' ||
      (url.pathname.endsWith('.html') && url.origin === self.location.origin)) {
    event.respondWith(networkFirst(request, CACHE_PAGES));
    return;
  }

  // 4. Assets estáticos locais → cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, CACHE_STATIC));
    return;
  }

  // 5. CDN externo (tailwind, fontawesome, google fonts) → stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request, CACHE_CDN));
});

// ── Estratégias ──────────────────────────────────────────────────────

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    const cached = await caches.match(request);
    return cached || offlineFallback(request);
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    return offlineFallback(request);
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || fetchPromise || offlineFallback(request);
}

function offlineFallback(request) {
  if (request.destination === 'document') {
    return caches.match('./index.html');
  }
  return new Response('', { status: 503, statusText: 'Offline' });
}

// ── Mensagens do cliente ─────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  if (event.data === 'getVersion')  event.ports[0]?.postMessage(CACHE_VERSION);
});
