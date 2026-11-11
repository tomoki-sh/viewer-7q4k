// 「タスク」のサービスワーカー。Web プッシュで届いた件数をアイコンのバッジに出す。
// 画面のファイルは通信を先に試し、通信できないときだけ控えを使う（更新をすぐ反映するため）。
const BUILD_ID = '20261111173928';
const CACHE_NAME = `tasks-${BUILD_ID}`;
const ASSETS = ['./', './index.html', './app.css', './js/app.js', './icon.png', './config.bin', '../js/crypto.js'];

// MARK: - 端末内の保存（app.js と同じ IndexedDB）

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('tasks', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, work) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('kv', mode);
    const request = work(transaction.objectStore('kv'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const getValue = (key) => withStore('readonly', (store) => store.get(key)).catch(() => null);
const setValue = (key, value) => withStore('readwrite', (store) => store.put(value, key)).catch(() => null);

// MARK: - 控え

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('tasks-') && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    // 画面を開くとき（navigate）の要求には設定を足せないので、URL から作り直す。
    const init = { cache: 'no-store', signal: controller.signal };
    const fresh = request.mode === 'navigate' ? new Request(request.url, init) : new Request(request, init);
    const response = await fetch(fresh);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request, { ignoreSearch: true })) ?? (await cache.match('./index.html')) ?? Response.error();
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});

// MARK: - Web プッシュ

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      data = {};
    }
    // 受け取るたびに必ず通知を 1 件出す（出さないと Safari が通知の許可を取り消す）。表示は iPhone の設定で隠す。
    await self.registration.showNotification('タスク', { body: '一覧を更新しました', tag: 'tasks', silent: true });
    const unread = Number.isFinite(data.unread) ? Math.max(0, Math.floor(data.unread)) : null;
    if (unread === null) return;
    // 届く順番が入れ替わったときは、送った時刻が新しい方を使う。
    const last = await getValue('pushed');
    if (last && (last.sentAt ?? 0) > (data.sentAt ?? 0)) return;
    await setValue('pushed', { unread, capped: data.capped === true, sentAt: data.sentAt ?? Date.now(), receivedAt: Date.now() });
    if ('setAppBadge' in self.navigator) {
      if (unread > 0) await self.navigator.setAppBadge(unread).catch(() => {});
      else await self.navigator.clearAppBadge().catch(() => {});
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => (windows[0] ? windows[0].focus() : self.clients.openWindow('./'))),
  );
});
