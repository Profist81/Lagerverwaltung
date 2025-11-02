// 5. sw.js
const CACHE = 'lager-cache-v8';
const CORE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest'
];

self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)));
  self.skipWaiting();
});
self.addEventListener('activate', (e)=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e)=>{
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then(cached=>{
      const fetcher = fetch(req).then(resp=>{
        const url = new URL(req.url);
        if (resp.ok && (url.origin===location.origin)) {
          const copy = resp.clone();
          caches.open(CACHE).then(c=>c.put(req, copy)).catch(()=>{});
        }
        return resp;
      }).catch(()=>cached);
      return cached || fetcher;
    })
  );
});

// Background Sync (best effort)
self.addEventListener('sync', async (event)=>{
  if (event.tag === 'lager-sync') {
    event.waitUntil((async()=>{
      // Notify all clients to flush any queues (we’re offline-only; this just triggers UI refresh)
      const clientsArr = await self.clients.matchAll({includeUncontrolled:true});
      for (const c of clientsArr) {
        c.postMessage({type:'flush'});
      }
    })());
  }
});

// Message channel
self.addEventListener('message', (e)=> {
  // Future hooks (e.g., push updates)
});
