// Servis çalışanı (tarayıcıda çalışan kod) — telefon bildirimi ve "ana ekrana ekle" için (4.2.33, karar 331).
// Bilerek YALNIZCA push + bildirime dokunma olaylarını işler: sayfa / dosya ÖNBELLEĞE ALINMAZ ve istekler araya
// girilmeden ağdan gelir (fetch olayı yok) — oturum gerektiren sayfalar telefonun belleğinde kalmaz, ekranda her zaman
// sunucudaki güncel bilgi vardır. Bildirimin adresi yalnızca bu sitenin içindeki bir yol olabilir.
export const SW_SOURCE = `'use strict';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

function sameSitePath(raw) {
  try {
    var u = new URL(typeof raw === 'string' && raw ? raw : '/', self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/';
  } catch (e) {
    return '/';
  }
}

self.addEventListener('push', function (event) {
  var d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  var title = typeof d.title === 'string' && d.title ? d.title : 'TAKİP';
  var options = {
    body: typeof d.body === 'string' ? d.body : '',
    icon: '/pwa/icon-192.png',
    badge: '/pwa/badge-96.png',
    data: { url: sameSitePath(d.url) },
  };
  if (typeof d.tag === 'string' && d.tag) options.tag = d.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = sameSitePath(event.notification.data && event.notification.data.url);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
        return c.focus().then(function (w) { return w && 'navigate' in w ? w.navigate(url) : undefined; }).catch(function () {});
      }
    }
    return self.clients.openWindow(url);
  }));
});
`;
