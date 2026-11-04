const CACHE_NAME = "vendly-commerce-v2";

// Instala o novo Service Worker
self.addEventListener("install", (event) => {
  console.log("Vendly Commerce: Service Worker v2 instalado.");

  // Ativa o novo Service Worker imediatamente
  self.skipWaiting();
});

// Assume o controle das páginas abertas
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Remove caches antigos do Vendly
      const cacheNames = await caches.keys();

      await Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName)),
      );

      // Assume o controle das páginas imediatamente
      await self.clients.claim();

      console.log("Vendly Commerce: Service Worker v2 ativado.");
    })(),
  );
});
