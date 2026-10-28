// 端末内の保存（IndexedDB）。
// kv: パスコード、鍵、暗号化した同梱データの控え。events: 起動・復帰の記録（ID をキーにするので重複しない）。

const DB_NAME = 'decoy';
const DB_VERSION = 1;
let databasePromise = null;

function openDatabase() {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  databasePromise.catch(() => {
    databasePromise = null;
  });
  return databasePromise;
}

async function withStore(name, mode, work) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, mode);
    const store = transaction.objectStore(name);
    let result;
    const request = work(store);
    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function getValue(key) {
  return withStore('kv', 'readonly', (store) => store.get(key));
}

export function setValue(key, value) {
  return withStore('kv', 'readwrite', (store) => store.put(value, key));
}

export function putEvent(event) {
  return withStore('events', 'readwrite', (store) => store.put(event));
}

export function allEvents() {
  return withStore('events', 'readonly', (store) => store.getAll());
}

// MARK: - IndexedDB に書けなかった記録の控え（localStorage）

const FALLBACK_KEY = 'pendingOpenEvents';

function readFallback() {
  try {
    return JSON.parse(localStorage.getItem(FALLBACK_KEY) ?? '[]');
  } catch {
    return [];
  }
}

/** 記録を保存する。失敗したら localStorage に控え、次の記録のときに IndexedDB へ移す。 */
export async function recordEvent(event) {
  const pending = readFallback();
  try {
    for (const item of pending) await putEvent(item);
    if (pending.length > 0) localStorage.removeItem(FALLBACK_KEY);
    await putEvent(event);
  } catch {
    try {
      const merged = [...pending.filter((item) => item.id !== event.id), event];
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(merged));
    } catch {
      // 端末の保存領域がいっぱいなどで控えもできない場合は、記録を保証できない。
    }
  }
}

/** 保存済みの記録と、控えに残っている記録をまとめて返す。 */
export async function loadAllEvents() {
  const pending = readFallback();
  let stored = [];
  try {
    stored = await allEvents();
  } catch {
    stored = [];
  }
  const byID = new Map();
  for (const event of [...stored, ...pending]) byID.set(event.id, event);
  return [...byID.values()];
}
