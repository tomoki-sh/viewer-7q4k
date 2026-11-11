// 画面の組み立てと、起動・復帰の判定、記録の保存をまとめる。
import {
  applyLive,
  dayKey,
  DEFAULT_LIVE_SETTINGS,
  detailItems,
  exportText,
  ForegroundEventDetector,
  listLabel,
  liveContactShown,
  logDays,
  makeSession,
  splitMemberCount,
} from './core.js';
import { decryptBundle, deriveKeyBytes, parseBundle, toHex } from './crypto.js';
import { decodeLive, fetchLive, subscribeLive } from './live.js';
import { getValue, loadAllEvents, recordEvent, setValue } from './store.js';

const BUILD_ID = '20261111173928';
const APP_VERSION = `pwa-${BUILD_ID}`;
const LOG_GESTURE_MS = 2500;

const $ = (id) => document.getElementById(id);

const state = {
  bundle: null,
  avatarURLs: new Map(),
  // baseSession はダミーだけのセッション。session はそれに本物のメッセージを合成したもの。
  baseSession: null,
  session: null,
  live: null,
  liveSettings: DEFAULT_LIVE_SETTINGS,
  stopLive: null,
  timeZone: currentTimeZone(),
  labelNow: Date.now(),
  openThreadID: null,
  alertShown: false,
  pendingStart: null,
};
const detector = new ForegroundEventDetector();

function currentTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

// MARK: - 起動と復帰

/** phase: 'active'（画面に表示された）か 'background'（画面から消えた）。 */
function handlePhase(phase) {
  const kind = detector.consume(phase);
  if (phase === 'background') {
    resetToList();
  }
  if (kind) {
    const event = {
      id: crypto.randomUUID(),
      detectedAt: Date.now(),
      kind,
      appVersion: APP_VERSION,
      timeZone: currentTimeZone(),
    };
    // 画面の表示は記録の完了を待たない。
    recordEvent(event);
    if (state.bundle) beginSession(event);
    else state.pendingStart = event;
  } else if (phase === 'active') {
    refreshLabels();
  }
}

document.addEventListener('visibilitychange', () => {
  handlePhase(document.visibilityState === 'visible' ? 'active' : 'background');
});

window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    handlePhase('background');
    handlePhase('active');
  }
});

function beginSession(event) {
  state.timeZone = event.timeZone;
  state.labelNow = event.detectedAt;
  state.baseSession = makeSession({
    id: event.id,
    catalog: state.bundle.catalog,
    startedAt: event.detectedAt,
    timeZone: event.timeZone,
  });
  state.session = applyLive(state.baseSession, state.live, state.liveSettings);
  hideAlert();
  closeThread(false);
  renderList();
  $('list-scroll').scrollTop = 0;
  startLive();
}

function resetToList() {
  hideAlert();
  closeThread(false);
  $('logs').hidden = true;
  stopLive();
}

// MARK: - 本物の通知の反映

/** 本物のメッセージを合成し直して描き直す。開いている会話が消えたときは一覧に戻す。 */
function rebuildSession() {
  if (!state.baseSession) return;
  state.session = applyLive(state.baseSession, state.live, state.liveSettings);
  renderList();
  if (!state.openThreadID) return;
  if (!currentThread()) {
    closeThread(false);
    return;
  }
  const scroll = $('detail-scroll');
  const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
  renderDetail();
  if (atBottom) scroll.scrollTop = scroll.scrollHeight;
}

async function applyLiveRaw(raw) {
  state.live = await decodeLive(raw);
  rebuildSession();
  if (!$('logs').hidden) renderLiveSettings();
}

/** 開いたとき（起動・復帰）に最新を取り、開いている間は更新を受け続ける。 */
async function startLive() {
  const endpoint = state.bundle?.live;
  if (!endpoint || state.stopLive) return;
  let stopped = false;
  let unsubscribe = null;
  state.stopLive = () => {
    stopped = true;
    unsubscribe?.();
    state.stopLive = null;
  };
  const raw = await fetchLive(endpoint);
  if (stopped) return;
  if (raw) await applyLiveRaw(raw);
  if (stopped) return;
  unsubscribe = subscribeLive(endpoint, raw, (next) => {
    applyLiveRaw(next);
  });
}

function stopLive() {
  state.stopLive?.();
}

async function loadLiveSettings() {
  try {
    const saved = await getValue('liveSettings');
    if (saved) state.liveSettings = { ...DEFAULT_LIVE_SETTINGS, ...saved };
  } catch {
    // 保存できない環境では初期値のまま使う。
  }
}

function saveLiveSettings() {
  setValue('liveSettings', state.liveSettings).catch(() => {});
  rebuildSession();
  renderLiveSettings();
}

function refreshLabels() {
  state.labelNow = Date.now();
  renderList();
  if (state.openThreadID) renderDetail();
}

// 閲覧中に日付が変わったら、ラベルだけを更新する。生成済みの日時は動かさない。
setInterval(() => {
  if (!state.session) return;
  if (dayKey(Date.now(), state.timeZone) !== dayKey(state.labelNow, state.timeZone)) refreshLabels();
}, 30_000);

// MARK: - 同梱データ

function passphraseFromHash() {
  const match = /(?:^|[#&])p=([^&]+)/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

async function fetchBundleBytes() {
  try {
    const response = await fetch(`data.bin?v=${BUILD_ID}`, { cache: 'no-cache' });
    if (response.ok) return await response.arrayBuffer();
  } catch {
    // 通信できないときは端末に控えた同梱データを使う。
  }
  try {
    return (await getValue('bundleBytes')) ?? null;
  } catch {
    return null;
  }
}

async function loadBundle(enteredPassphrase = null) {
  const buffer = await fetchBundleBytes();
  if (!buffer) return null;
  let parsed;
  try {
    parsed = parseBundle(buffer);
  } catch {
    return null;
  }
  const saltHex = toHex(parsed.salt);
  let stored = {};
  try {
    stored = {
      key: await getValue('key'),
      passphrase: await getValue('passphrase'),
      bundleBuild: await getValue('bundleBuild'),
    };
  } catch {
    stored = {};
  }

  const candidates = [];
  if (enteredPassphrase) candidates.push({ passphrase: enteredPassphrase });
  if (stored.key && stored.key.saltHex === saltHex && stored.key.iterations === parsed.iterations) {
    candidates.push({ keyBytes: stored.key.bytes, passphrase: stored.passphrase });
  }
  const fromHash = passphraseFromHash();
  if (fromHash) candidates.push({ passphrase: fromHash });
  if (stored.passphrase) candidates.push({ passphrase: stored.passphrase });

  for (const candidate of candidates) {
    try {
      const keyBytes = candidate.keyBytes
        ?? await deriveKeyBytes(candidate.passphrase, parsed.salt, parsed.iterations);
      const bundle = await decryptBundle(parsed, keyBytes);
      try {
        await setValue('key', { saltHex, iterations: parsed.iterations, bytes: keyBytes });
        if (candidate.passphrase) await setValue('passphrase', candidate.passphrase);
        if (stored.bundleBuild !== bundle.buildId) {
          await setValue('bundleBytes', buffer);
          await setValue('bundleBuild', bundle.buildId);
        }
      } catch {
        // 保存できなくても、この起動では表示できる。
      }
      return bundle;
    } catch {
      // 次の候補を試す。
    }
  }
  return null;
}

function base64ToObjectURL(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type }));
}

function setMeta(name, content) {
  let meta = document.querySelector(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = name;
    document.head.append(meta);
  }
  meta.content = content;
}

/** 解錠した後だけ、ホーム画面に追加するときの名前とアイコンを本来のものにする。 */
function applyBranding(bundle) {
  document.title = bundle.appName;
  setMeta('apple-mobile-web-app-title', bundle.appName);
  if (bundle.appIcon) {
    let link = document.querySelector('link[rel="apple-touch-icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'apple-touch-icon';
      document.head.append(link);
    }
    link.href = bundle.appIcon;
  }
}

function applyBundle(bundle) {
  state.bundle = bundle;
  for (const url of state.avatarURLs.values()) URL.revokeObjectURL(url);
  state.avatarURLs.clear();
  for (const [name, image] of Object.entries(bundle.avatars ?? {})) {
    state.avatarURLs.set(name, base64ToObjectURL(image.data, image.type));
  }
  applyBranding(bundle);
  $('unlock').hidden = true;
  $('app').hidden = false;
  if (state.pendingStart) {
    const event = state.pendingStart;
    state.pendingStart = null;
    beginSession(event);
  }
}

// MARK: - 一覧

const FALLBACK_COLORS = ['#9eb3cc', '#cca894', '#99c2a3', '#c7a3c2', '#d6bd85'];

function fallbackColor(seed) {
  let total = 0;
  for (const char of seed) total = (total + char.codePointAt(0)) % 9973;
  return FALLBACK_COLORS[total % FALLBACK_COLORS.length];
}

const BADGES = {
  pin: '<span class="pin-badge"><svg><use href="#i-pin"/></svg></span>',
  openchat: '<span class="openchat-badge"><svg><use href="#i-openchat"/></svg></span>',
};

function avatarHTML(asset, name, { badge = null, small = false } = {}) {
  const url = asset ? state.avatarURLs.get(asset) : null;
  const image = url
    ? `<img class="avatar" src="${url}" alt="" draggable="false">`
    : `<span class="avatar avatar-fallback" style="background:${fallbackColor(`${asset}${name}`)}">${escapeHTML([...name][0] ?? '')}</span>`;
  return `<span class="avatar-wrap${small ? ' small' : ''}">${image}${badge ? BADGES[badge] : ''}</span>`;
}

/** 名前。グループの人数は別にして、名前が長くて省略されても残す。 */
function nameHTML(displayName, prefix) {
  const { name, count } = splitMemberCount(displayName);
  if (!count) return `<span class="${prefix}-name">${escapeHTML(name)}</span>`;
  return `<span class="${prefix}-label"><span class="${prefix}-name">${escapeHTML(name)}</span>`
    + `<span class="${prefix}-count">${escapeHTML(count)}</span></span>`;
}

function renderList() {
  const session = state.session;
  if (!session) return;
  // 固定相手は、本物のメッセージが届いていれば他の行と同じく本文と日時を出し、押すと会話を開く。
  const rows = session.pinned.map((contact) => {
    const avatar = avatarHTML(contact.avatarAsset, contact.displayName, { badge: 'pin' });
    const name = `<span class="row-name">${escapeHTML(contact.displayName)}</span>`;
    if (!contact.thread) {
      return `<button class="row" data-error>${avatar}<span class="row-body"><span class="row-top">${name}</span>`
        + '<span class="row-preview"></span></span></button>';
    }
    const label = listLabel(contact.thread.latest.date, state.labelNow, state.timeZone);
    return `<button class="row" data-thread="${escapeHTML(contact.id)}">${avatar}`
      + `<span class="row-body"><span class="row-top">${name}<span class="row-date">${escapeHTML(label)}</span></span>`
      + `<span class="row-preview">${escapeHTML(contact.thread.latest.text)}</span></span></button>`;
  });
  for (const thread of session.threads) {
    const label = listLabel(thread.latest.date, state.labelNow, state.timeZone);
    const badge = thread.isOpenChat ? 'openchat' : null;
    rows.push(
      `<button class="row" data-thread="${escapeHTML(thread.id)}">${avatarHTML(thread.avatarAsset, thread.displayName, { badge })}`
        + '<span class="row-body"><span class="row-top">'
        + nameHTML(thread.displayName, 'row')
        + (thread.isMuted ? '<svg class="row-mute"><use href="#i-mute"/></svg>' : '')
        + `<span class="row-date">${escapeHTML(label)}</span></span>`
        + `<span class="row-preview">${escapeHTML(thread.latest.text)}</span></span></button>`,
    );
  }
  $('rows').innerHTML = rows.join('');
}

// MARK: - 会話

const TAIL_SVG = '<svg class="tail" viewBox="-4.5 -1 18.5 14"><path d="M14 0Q3-.5-4.5-1Q-.5 3 .5 13L14 13Z"/></svg>';

function messageHTML(item, thread) {
  const message = item.message;
  const start = item.startsGroup ? ' group-start' : '';
  const tail = item.startsGroup ? TAIL_SVG : '';
  const text = escapeHTML(message.text);
  if (message.sender === 'me') {
    const read = message.readCount ? `既読 ${message.readCount}` : '既読';
    return `<div class="msg me${start}"><div class="meta">${read}<br>${item.timeLabel}</div>`
      + `<div class="bubble">${tail}${text}</div></div>`;
  }
  const avatar = item.startsGroup
    ? avatarHTML(message.senderName ? (message.senderAvatar ?? '') : thread.avatarAsset, message.senderName ?? thread.displayName, { small: true })
    : '<span class="avatar-space"></span>';
  const sender = item.startsGroup && message.senderName
    ? `<div class="sender">${escapeHTML(message.senderName)}</div>`
    : '';
  return `<div class="msg other${start}">${avatar}<div class="other-col">${sender}`
    + `<div class="other-line"><div class="bubble">${tail}${text}</div><div class="meta">${item.timeLabel}</div></div></div></div>`;
}

function currentThread() {
  const id = state.openThreadID;
  if (!state.session || !id) return null;
  return state.session.threads.find((thread) => thread.id === id)
    ?? state.session.pinned.find((contact) => contact.id === id)?.thread
    ?? null;
}

function renderDetail() {
  const thread = currentThread();
  if (!thread) return;
  $('detail-title').innerHTML = nameHTML(thread.displayName, 'detail');
  $('messages').innerHTML = detailItems(thread, state.labelNow, state.timeZone)
    .map((item) => (item.type === 'separator'
      ? `<div class="sep"><span>${escapeHTML(item.label)}</span></div>`
      : messageHTML(item, thread)))
    .join('');
}

function openThread(id) {
  if (state.openThreadID || state.alertShown || !state.session) return;
  state.openThreadID = id;
  renderDetail();
  const detail = $('detail');
  const list = $('list');
  detail.hidden = false;
  detail.classList.remove('open');
  const scroll = $('detail-scroll');
  scroll.scrollTop = scroll.scrollHeight;
  void detail.offsetWidth;
  detail.classList.add('open');
  list.classList.add('pushed');
  requestAnimationFrame(() => {
    scroll.scrollTop = scroll.scrollHeight;
  });
}

function closeThread(animated = true) {
  const detail = $('detail');
  const list = $('list');
  if (!state.openThreadID && detail.hidden) return;
  state.openThreadID = null;
  detail.style.transform = '';
  list.style.transform = '';
  if (!animated) {
    detail.style.transition = 'none';
    list.style.transition = 'none';
    detail.classList.remove('open');
    list.classList.remove('pushed');
    detail.hidden = true;
    void detail.offsetWidth;
    detail.style.transition = '';
    list.style.transition = '';
    return;
  }
  detail.classList.remove('open');
  list.classList.remove('pushed');
  detail.addEventListener('transitionend', () => {
    if (!state.openThreadID) detail.hidden = true;
  }, { once: true });
}

// 画面の左端からのスワイプで一覧へ戻る。
function setupSwipeBack() {
  const detail = $('detail');
  const list = $('list');
  let swipe = null;

  detail.addEventListener('touchstart', (event) => {
    if (!state.openThreadID || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (touch.clientX > 24) return;
    swipe = { startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastT: event.timeStamp, dx: 0, velocity: 0, active: false };
  }, { passive: true });

  detail.addEventListener('touchmove', (event) => {
    if (!swipe) return;
    const touch = event.touches[0];
    const dx = touch.clientX - swipe.startX;
    const dy = touch.clientY - swipe.startY;
    if (!swipe.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        swipe = null;
        return;
      }
      if (dx < 6) return;
      swipe.active = true;
    }
    event.preventDefault();
    const elapsed = Math.max(1, event.timeStamp - swipe.lastT);
    swipe.velocity = (touch.clientX - swipe.lastX) / elapsed;
    swipe.lastX = touch.clientX;
    swipe.lastT = event.timeStamp;
    swipe.dx = Math.max(0, dx);
    const width = window.innerWidth;
    detail.style.transition = 'none';
    list.style.transition = 'none';
    detail.style.transform = `translateX(${swipe.dx}px)`;
    list.style.transform = `translateX(${-28 + (28 * swipe.dx) / width}%)`;
  }, { passive: false });

  const finish = () => {
    if (!swipe) return;
    const done = swipe;
    swipe = null;
    if (!done.active) return;
    detail.style.transition = '';
    list.style.transition = '';
    if (done.dx > window.innerWidth * 0.33 || done.velocity > 0.5) {
      state.openThreadID = null;
      detail.style.transform = 'translateX(100%)';
      list.style.transform = 'translateX(0)';
      detail.addEventListener('transitionend', () => {
        if (state.openThreadID) return;
        detail.hidden = true;
        detail.classList.remove('open');
        list.classList.remove('pushed');
        detail.style.transform = '';
        list.style.transform = '';
      }, { once: true });
    } else {
      detail.style.transform = '';
      list.style.transform = '';
    }
  };
  detail.addEventListener('touchend', finish);
  detail.addEventListener('touchcancel', finish);
}

// MARK: - 共通エラー

function showAlert() {
  if (state.alertShown) return;
  state.alertShown = true;
  $('alert').hidden = false;
}

function hideAlert() {
  state.alertShown = false;
  $('alert').hidden = true;
}

// MARK: - 記録の画面（「トーク」を長押しで開く）

let suppressNextErrorClick = false;

function setupLogGesture() {
  const trigger = $('seg-talk');
  let timer = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  trigger.addEventListener('pointerdown', () => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      suppressNextErrorClick = true;
      openLogs();
    }, LOG_GESTURE_MS);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) trigger.addEventListener(type, cancel);
  trigger.addEventListener('contextmenu', (event) => event.preventDefault());
}

function exportFileName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `open_history_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.txt`;
}

// 書き出しとコピーは native 版と同じ TSV のまま。画面には日ごとの一覧を出す。
let logsText = '';

function logsHTML(events) {
  const days = logDays(events, Date.now(), currentTimeZone());
  if (days.length === 0) return '<p class="logs-empty">まだ記録はありません</p>';
  return days.map((day) => (
    `<section class="logs-day"><h2 class="logs-day-title">${escapeHTML(day.label)}</h2><ul class="logs-rows">`
      + day.rows.map((row) => (
        `<li class="logs-row"><span class="logs-time">${escapeHTML(row.time)}</span>`
          + (row.timeZone ? `<span class="logs-zone">${escapeHTML(row.timeZone)}</span>` : '')
          + `<span class="logs-kind ${row.kind === 'launch' ? 'launch' : 'resume'}">${escapeHTML(row.kindLabel)}</span></li>`
      )).join('')
      + '</ul></section>'
  )).join('') + '<p class="logs-note">起動は新しく開いたとき、復帰はホーム画面などから戻ったときの記録です。</p>';
}

async function openLogs() {
  const events = await loadAllEvents();
  logsText = exportText(events);
  const launches = events.filter((event) => event.kind === 'launch').length;
  $('logs-summary').textContent = `${events.length} 件（起動 ${launches}、復帰 ${events.length - launches}）`;
  $('logs-status').textContent = '';
  $('logs-days').innerHTML = logsHTML(events);
  renderLiveSettings();
  $('logs-list').scrollTop = 0;
  $('logs').hidden = false;
}

// 記録の画面の下に置く、本物のトークの反映の設定。名前は復号したデータからだけ描く。
const LIVE_KIND_LABEL = { pinned: '固定の相手', thread: '既存の行', extra: '新しい行' };

function renderLiveSettings() {
  const box = $('live-settings');
  if (!state.bundle?.live) {
    box.innerHTML = '';
    return;
  }
  const settings = state.liveSettings;
  const contacts = [...(state.live?.contacts ?? [])]
    .map((contact) => ({ contact, last: Math.max(0, ...contact.messages.map((message) => message.date)) }))
    .sort((a, b) => b.last - a.last);
  const toggle = (attribute, checked) => (
    `<label class="switch"><input type="checkbox" ${attribute}${checked ? ' checked' : ''}><span></span></label>`
  );
  const rows = contacts.map(({ contact, last }) => {
    const kind = contact.threadId === 'pinned' ? 'pinned' : contact.threadId ? 'thread' : 'extra';
    const when = last ? listLabel(last, Date.now(), currentTimeZone()) : '';
    return `<li class="logs-row live-row"><span class="live-name">${escapeHTML(contact.name ?? '')}`
      + `<small>${LIVE_KIND_LABEL[kind]}・${escapeHTML(when)}・${contact.messages.length} 件</small></span>`
      + `${toggle(`data-contact="${escapeHTML(contact.key)}"`, liveContactShown({ ...contact }, { ...settings, enabled: true }))}</li>`;
  }).join('');
  box.innerHTML = '<section class="logs-day"><h2 class="logs-day-title">本物のトークの反映</h2><ul class="logs-rows">'
    + `<li class="logs-row live-row"><span class="live-name">反映する</span>${toggle('data-live="enabled"', settings.enabled !== false)}</li>`
    + `<li class="logs-row live-row"><span class="live-name">新しい相手も表示する</span>${toggle('data-live="showNew"', settings.showNew !== false)}</li>`
    + '</ul>'
    + (rows
      ? `<h2 class="logs-day-title">届いた相手（新しい順）</h2><ul class="logs-rows">${rows}</ul>`
      : '<p class="logs-note">まだ届いた相手はいません。</p>')
    + '<p class="logs-note">オフにした相手は、ダミーの会話のまま表示します（新しい行の相手は出しません）。</p></section>';
}

function setupLiveSettings() {
  $('live-settings').addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const settings = { ...state.liveSettings, choices: { ...state.liveSettings.choices } };
    if (input.dataset.live) settings[input.dataset.live] = input.checked;
    else if (input.dataset.contact) settings.choices[input.dataset.contact] = input.checked;
    else return;
    state.liveSettings = settings;
    saveLiveSettings();
  });
}

async function shareLogs() {
  const file = new File([logsText], exportFileName(), { type: 'text/plain' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
  }
  await copyLogs();
}

async function copyLogs() {
  try {
    await navigator.clipboard.writeText(logsText);
    $('logs-status').textContent = 'コピーしました';
  } catch {
    $('logs-status').textContent = 'コピーできませんでした';
  }
}

// MARK: - 解錠画面

function showUnlock() {
  $('app').hidden = true;
  $('unlock').hidden = false;
}

async function submitUnlock(event) {
  event.preventDefault();
  const input = $('unlock-input');
  const value = input.value.trim();
  if (!value) return;
  $('unlock-submit').disabled = true;
  $('unlock-error').hidden = true;
  const bundle = await loadBundle(value);
  $('unlock-submit').disabled = false;
  if (!bundle) {
    $('unlock-error').hidden = false;
    return;
  }
  input.value = '';
  input.blur();
  applyBundle(bundle);
}

// MARK: - 起動

function setupEvents() {
  document.addEventListener('click', (event) => {
    const errorTarget = event.target.closest('[data-error]');
    if (errorTarget) {
      if (suppressNextErrorClick) {
        suppressNextErrorClick = false;
        return;
      }
      showAlert();
      return;
    }
    const row = event.target.closest('[data-thread]');
    if (row) openThread(row.dataset.thread);
  });
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  $('alert-ok').addEventListener('click', hideAlert);
  $('back').addEventListener('click', () => closeThread(true));
  $('logs-close').addEventListener('click', () => {
    $('logs').hidden = true;
  });
  $('logs-share').addEventListener('click', shareLogs);
  $('logs-copy').addEventListener('click', copyLogs);
  $('unlock-form').addEventListener('submit', submitUnlock);
  setupSwipeBack();
  setupLogGesture();
  setupLiveSettings();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

async function boot() {
  setupEvents();
  registerServiceWorker();
  if (document.visibilityState === 'visible') handlePhase('active');
  const [bundle] = await Promise.all([loadBundle(), loadLiveSettings()]);
  if (bundle) {
    applyBundle(bundle);
    navigator.storage?.persist?.().catch(() => {});
  } else {
    showUnlock();
  }
}

boot();
