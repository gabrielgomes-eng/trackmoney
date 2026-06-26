/* ═══════════════════════════════════════
   TrackMoney — Service Worker (PWA)
   ═══════════════════════════════════════ */

const CACHE_NAME = 'trackmoney-v2';

// Arquivos locais do app
const LOCAL_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Bibliotecas externas (CDN) — necessárias pro app funcionar mesmo offline
// depois do primeiro carregamento (Chart.js, jsPDF, ícones).
// OBS: Firebase SDK (gstatic) não entra aqui de propósito, pois autenticação
// e Firestore exigem conexão de qualquer forma.
const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://code.iconify.design/iconify-icon/1.0.7/iconify-icon.min.js'
];

// Instala e faz cache dos assets (locais + CDN)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // Assets locais (mesma origem) — cache.addAll funciona normalmente
      await cache.addAll(LOCAL_ASSETS);

      // Assets de CDN (origem cruzada) — precisa request individual em modo no-cors
      await Promise.all(
        CDN_ASSETS.map(url =>
          fetch(url, { mode: 'no-cors' })
            .then(response => cache.put(url, response))
            .catch(() => null) // se falhar (ex: sem internet no install), ignora
        )
      );
    })
  );
  self.skipWaiting();
});

// Limpa caches antigos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estratégia: Network first, fallback para cache
self.addEventListener('fetch', event => {
  // Ignora requisições não-GET e Firebase
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('firestore') || 
      event.request.url.includes('googleapis') ||
      event.request.url.includes('gstatic')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Atualiza cache com resposta mais recente
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
