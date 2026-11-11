// 本物の通知の反映データの取得と復号。置き場所は Firebase Realtime Database（REST と EventSource）。
//
// 置き場所の値: { t: { <相手ごとの名前>: "<暗号化した base64>" } }。中身は相手ごとの
// { key, name, threadId, updatedAt, messages: [{ id, sender, text, date }] }（data.bin と同じ方式で暗号化）。
// 取れた値は暗号化したまま端末に控え、通信できないときに使う。
import { decryptBundle, deriveKeyBytes, parseBundle, toHex } from './crypto.js';
import { getValue, setValue } from './store.js';

const POLL_MS = 15_000;
const decrypted = new Map();
let keyBytes = null;

function locationURL(endpoint) {
  return `${endpoint.url}/${endpoint.root}/${endpoint.key}.json`;
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/** 同梱データと同じ鍵を使う。ソルトか反復回数が違うときだけ、保存したパスコードから作り直す。 */
async function keyFor(parsed) {
  const saltHex = toHex(parsed.salt);
  if (keyBytes?.saltHex === saltHex && keyBytes.iterations === parsed.iterations) return keyBytes.bytes;
  const stored = await getValue('key').catch(() => null);
  if (stored?.saltHex === saltHex && stored.iterations === parsed.iterations) {
    keyBytes = stored;
    return stored.bytes;
  }
  const passphrase = await getValue('passphrase').catch(() => null);
  if (!passphrase) return null;
  const bytes = await deriveKeyBytes(passphrase, parsed.salt, parsed.iterations);
  keyBytes = { saltHex, iterations: parsed.iterations, bytes };
  return bytes;
}

async function decryptItem(base64) {
  if (typeof base64 !== 'string') return null;
  if (decrypted.has(base64)) return decrypted.get(base64);
  let value = null;
  try {
    const parsed = parseBundle(base64ToBuffer(base64));
    const bytes = await keyFor(parsed);
    if (bytes) value = await decryptBundle(parsed, bytes);
  } catch {
    value = null;
  }
  decrypted.set(base64, value);
  return value;
}

/** 置き場所の生の値を、画面で使う形（{ contacts }）にする。読めない項目は飛ばす。 */
export async function decodeLive(raw) {
  const contacts = [];
  for (const value of Object.values(raw?.t ?? {})) {
    const contact = await decryptItem(value);
    if (contact?.key && Array.isArray(contact.messages)) contacts.push(contact);
  }
  return { contacts };
}

/** 最新の値を取りに行く。取れなければ、端末に控えた値を返す。 */
export async function fetchLive(endpoint) {
  try {
    const response = await fetch(locationURL(endpoint), { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = (await response.json()) ?? {};
    setValue('liveRaw', raw).catch(() => {});
    return raw;
  } catch {
    return (await getValue('liveRaw').catch(() => null)) ?? null;
  }
}

function setAt(root, path, value) {
  const keys = path.split('/').filter(Boolean);
  if (keys.length === 0) return value ?? {};
  const next = { ...(root ?? {}) };
  let node = next;
  for (const key of keys.slice(0, -1)) {
    node[key] = { ...(node[key] ?? {}) };
    node = node[key];
  }
  const last = keys[keys.length - 1];
  if (value === null) delete node[last];
  else node[last] = value;
  return next;
}

/**
 * 開いている間の更新を受ける。EventSource が使えないとき・切れたときは一定間隔で取りに行く。
 * 戻り値の関数で止める。
 */
export function subscribeLive(endpoint, initial, onRaw) {
  let raw = initial ?? {};
  let source = null;
  let timer = null;
  let stopped = false;
  const deliver = (next) => {
    raw = next;
    setValue('liveRaw', raw).catch(() => {});
    onRaw(raw);
  };
  const poll = () => {
    if (timer || stopped) return;
    timer = setInterval(async () => {
      try {
        const response = await fetch(locationURL(endpoint), { cache: 'no-store' });
        if (response.ok) deliver((await response.json()) ?? {});
      } catch {
        // 次の回に試す。
      }
    }, POLL_MS);
  };
  if (typeof EventSource === 'function') {
    source = new EventSource(locationURL(endpoint));
    source.addEventListener('put', (event) => {
      const { path, data } = JSON.parse(event.data);
      deliver(setAt(raw, path, data));
    });
    source.addEventListener('patch', (event) => {
      const { path, data } = JSON.parse(event.data);
      let next = raw;
      for (const [key, value] of Object.entries(data ?? {})) next = setAt(next, `${path}/${key}`, value);
      deliver(next);
    });
    source.addEventListener('cancel', () => {
      source.close();
      poll();
    });
    source.addEventListener('error', () => {
      if (source.readyState === EventSource.CLOSED) poll();
    });
  } else {
    poll();
  }
  return () => {
    stopped = true;
    source?.close();
    if (timer) clearInterval(timer);
    timer = null;
  };
}
