// H-CAR service worker: shows push notifications, mainly the
// "Are you okay?" check-in when an Act flag fires while the app is closed.
// No health data is cached here. Tapping a notification opens the app.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'H-CAR', body: event.data ? event.data.text() : 'Open H-CAR.' };
  }
  const title = data.title || 'H-CAR';
  const options = {
    body: data.body || 'Open H-CAR to check in.',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: { url: data.url || '/', alertId: data.alertId || null },
    requireInteraction: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
