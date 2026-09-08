/* Graph Studio service worker — kill-switch.

   Прежний воркер (graph-studio-v2) перехватывал ЛЮБОЙ same-origin GET, кэшировал его
   навсегда и при сетевой ошибке отдавал HTML-оболочку с кодом 200. С появлением /api/
   это ломало бы разбор ответов: res.json() падал бы на «Unexpected token '<'»,
   а реальные сбои сети и сервера маскировались бы под успешный ответ.

   Плюс install делал cache.addAll(['graph_studio.html', ...]). После переезда на сборку
   этого файла не станет, addAll провалился бы, установка нового воркера не прошла бы —
   и на машинах людей навсегда остался бы жить старый воркер со старой оболочкой.

   Поэтому здесь нет ни кэша, ни обработчика fetch: воркер снимает сам себя и уходит.
   Приложение больше его не регистрирует. Браузер сам проверяет sw.js при переходах,
   поэтому уже установленные воркеры получат эту версию и разрегистрируются.
   Когда понадобится офлайн снова — новый воркер обязан первой же строкой в fetch
   пропускать /api/ и /ws мимо себя. */

const wipe = async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
};

self.addEventListener('install', e => {
  e.waitUntil(wipe().then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    await wipe();
    await self.clients.claim();
    await self.registration.unregister();
  })());
});

// Обработчика fetch нет намеренно: запросы идут в сеть напрямую.
