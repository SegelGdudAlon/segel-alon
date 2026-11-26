// Service worker להתראות פוש. חייב לשבת באותה תיקייה כמו index.html.
self.window = self;
importScripts('./firebase-config.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp(self.APP_CONFIG.firebase);
// ההודעה עצמה (כותרת, טקסט, קישור) נבנית בשרת ומוצגת אוטומטית
firebase.messaging();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// לחיצה על התראה מקומית (בדיקה) — פותחת את האתר
self.addEventListener('notificationclick', e => {
  if(e.notification && e.notification.data && e.notification.data.FCM_MSG) return;   // מטופל ע״י Firebase
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
    for(const c of list){ if('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
