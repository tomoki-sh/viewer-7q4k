// 「タスク」: 件数をホーム画面のアイコンのバッジに出す小さな Web アプリ。
// 件数は Web プッシュで届き、サービスワーカー（sw.js）がバッジを書き換える。
// 開いたときは、暗号化された状態（件数、確認の時刻、取得元の調子）を読んで表示し、バッジも合わせる。
// 置き場所と鍵は暗号化した config.bin にだけ入っている（パスコードで開く。パスコードは導入リンクの #p= で渡す）。
import { decryptBundle, deriveKeyBytes, parseBundle, toHex } from '../../js/crypto.js';

const BUILD_ID = '20261111173928';
const $ = (id) => document.getElementById(id);
const state = { config: null, keyBytes: null, registration: null, busy: false };

// MARK: - 端末内の保存（IndexedDB。sw.js にも同じ名前で同じものがある）

const DB_NAME = 'tasks';
let databasePromise = null;

function openDatabase() {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  databasePromise.catch(() => {
    databasePromise = null;
  });
  return databasePromise;
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

// MARK: - 小さな道具

function base64ToBytes(text) {
  const normal = text.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = normal + '='.repeat((4 - (normal.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function formatTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
  return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

function showNote(text) {
  $('note').textContent = text;
  $('note').hidden = !text;
}

// MARK: - 開く

function passphraseFromHash() {
  const match = /(?:^|[#&])p=([^&]+)/u.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

async function fetchConfig() {
  try {
    const response = await fetch(`config.bin?v=${BUILD_ID}`, { cache: 'no-cache' });
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      await setValue('configBytes', buffer);
      return buffer;
    }
    if (response.status === 404) return null;
  } catch {
    // 通信できないときは端末の控えを使う。
  }
  return getValue('configBytes');
}

/** 戻り値: ok（開けた）、locked（パスコードが要る）、missing（まだ設定が配られていない）。 */
async function unlock(entered = null) {
  const buffer = await fetchConfig();
  if (!buffer) return 'missing';
  let parsed;
  try {
    parsed = parseBundle(buffer);
  } catch {
    return 'missing';
  }
  const saltHex = toHex(parsed.salt);
  const storedKey = await getValue('key');
  const storedPassphrase = await getValue('passphrase');
  const candidates = [];
  if (entered) candidates.push({ passphrase: entered });
  if (storedKey?.saltHex === saltHex && storedKey.iterations === parsed.iterations) candidates.push({ keyBytes: storedKey.bytes });
  const fromHash = passphraseFromHash();
  if (fromHash) candidates.push({ passphrase: fromHash });
  if (storedPassphrase) candidates.push({ passphrase: storedPassphrase });
  for (const candidate of candidates) {
    try {
      const keyBytes = candidate.keyBytes ?? await deriveKeyBytes(candidate.passphrase, parsed.salt, parsed.iterations);
      state.config = await decryptBundle(parsed, keyBytes);
      state.keyBytes = keyBytes;
      await setValue('key', { saltHex, iterations: parsed.iterations, bytes: keyBytes });
      if (candidate.passphrase) await setValue('passphrase', candidate.passphrase);
      return 'ok';
    } catch {
      // 次の候補を試す。
    }
  }
  return 'locked';
}

// MARK: - 件数と同期の状態

const SYNC_LABELS = {
  'no-access': '許可が必要です',
  declined: '許可が必要です',
  'no-window': '窓が閉じています',
  'not-running': '起動していません',
  stale: '応答がありません',
  pending: '準備中',
};

function syncLabel(status) {
  if (!status) return '準備中';
  if (!status.ok) {
    if (SYNC_LABELS[status.error]) return SYNC_LABELS[status.error];
    return String(status.error ?? '').startsWith('read-') ? '読み取りに失敗しました' : '停止中';
  }
  // 取得元は 1 分ごとに状態を書き直す。3 分以上古ければ止まっているとみなす。
  if (Date.now() - (status.publishedAt ?? 0) > 3 * 60_000) return '応答がありません';
  return '正常';
}

function renderStatus(status) {
  const unread = status?.unread;
  $('count').textContent = unread === null || unread === undefined ? '–' : `${unread}${status.capped ? '+' : ''}`;
  $('updated').textContent = status?.checkedAt ? `確認 ${formatTime(status.checkedAt)}` : '';
  $('sync-state').textContent = syncLabel(status);
}

async function applyBadge(status) {
  if (!status?.ok || !Number.isFinite(status.unread) || !('setAppBadge' in navigator)) return;
  try {
    if (status.unread > 0) await navigator.setAppBadge(status.unread);
    else await navigator.clearAppBadge();
  } catch {
    // バッジの許可が無いときなど。
  }
}

async function updateStatus() {
  const config = state.config;
  if (!config?.dbUrl) {
    $('sync-state').textContent = '準備中';
    return;
  }
  try {
    const response = await fetch(`${config.dbUrl}/${config.root ?? 's'}/${config.pairKey}/status.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const sealed = await response.json();
    if (typeof sealed !== 'string') {
      $('sync-state').textContent = '準備中';
      return;
    }
    const status = await decryptBundle(parseBundle(base64ToBytes(sealed)), state.keyBytes);
    await setValue('status', status);
    renderStatus(status);
    await applyBadge(status);
  } catch {
    $('sync-state').textContent = 'オフライン';
  }
}

// MARK: - 通知（Web プッシュの購読）

async function registerSubscription(subscription, force = false) {
  const config = state.config;
  const json = subscription.toJSON();
  if (!config?.dbUrl || !json.keys?.p256dh || !json.keys?.auth) return;
  const target = await sha256Hex(`${config.dbUrl}|${config.pairKey}`);
  const registered = await getValue('registered');
  const fresh = registered?.endpoint === json.endpoint && registered.target === target
    && Date.now() - registered.at < 7 * 86_400_000;
  if (fresh && !force) return;
  const id = (await sha256Hex(json.endpoint)).slice(0, 16);
  const response = await fetch(`${config.dbUrl}/${config.root ?? 's'}/${config.pairKey}/sub/${id}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, at: Date.now() }),
  });
  if (response.ok) await setValue('registered', { endpoint: json.endpoint, target, at: Date.now() });
}

async function updateNotify() {
  const button = $('enable');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    $('notify-state').textContent = isStandalone() ? '使えません' : 'ホーム画面に追加して開いてください';
    button.hidden = true;
    return;
  }
  state.registration ??= await navigator.serviceWorker.ready;
  let subscription = await state.registration.pushManager.getSubscription();
  const wanted = base64ToBytes(state.config.vapidPublicKey);
  const current = subscription?.options?.applicationServerKey;
  if (subscription && current && !sameBytes(new Uint8Array(current), wanted)) {
    // 鍵が変わった（Mac 側で作り直した）ときは、古い購読を外して有効にし直してもらう。
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  if (Notification.permission === 'denied') {
    $('notify-state').textContent = 'オフ（設定アプリの「通知」で許可）';
    button.hidden = true;
    return;
  }
  if (!subscription || Notification.permission !== 'granted') {
    $('notify-state').textContent = 'オフ';
    button.hidden = false;
    return;
  }
  $('notify-state').textContent = 'オン';
  button.hidden = true;
  await registerSubscription(subscription).catch(() => {});
}

function enable() {
  if (state.busy || !state.registration || !state.config) return;
  state.busy = true;
  showNote('');
  // Safari の決まり: 押した操作の中で、すぐに購読を呼ぶ（許可の確認もここで出る）。
  state.registration.pushManager
    .subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(state.config.vapidPublicKey) })
    .then((subscription) => registerSubscription(subscription, true))
    .catch(() => showNote('通知を有効にできませんでした。設定アプリの「通知」で許可を確かめてください。'))
    .finally(() => {
      state.busy = false;
      updateNotify().catch(() => {});
    });
}

// MARK: - 起動

async function refresh() {
  await Promise.allSettled([updateNotify(), updateStatus()]);
}

function showHome() {
  $('unlock').hidden = true;
  $('home').hidden = false;
}

async function submitUnlock(event) {
  event.preventDefault();
  const value = $('unlock-input').value.trim();
  if (!value) return;
  $('unlock-submit').disabled = true;
  const result = await unlock(value);
  $('unlock-submit').disabled = false;
  if (result !== 'ok') {
    $('unlock-error').hidden = false;
    return;
  }
  await start();
}

async function start() {
  showHome();
  const cached = await getValue('status');
  if (cached) renderStatus(cached);
  await refresh();
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, 15_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}

async function boot() {
  $('unlock-form').addEventListener('submit', submitUnlock);
  $('enable').addEventListener('click', enable);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).catch(() => {});
  }
  navigator.storage?.persist?.().catch(() => {});
  const result = await unlock();
  if (result === 'ok') {
    await start();
    return;
  }
  if (result === 'missing') {
    showHome();
    $('notify-state').textContent = '準備中';
    $('sync-state').textContent = '準備中';
    return;
  }
  $('home').hidden = true;
  $('unlock').hidden = false;
}

boot();
