// DecoyCore（Swift）の JavaScript 版。画面に依存しない純粋なロジックだけを置く。
// ブラウザと Node（テスト・ビルド）の両方から読み込む。

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MINUTE = 60_000;
const DAY = 86_400_000;

// MARK: - 暦の計算（タイムゾーンを指定したグレゴリオ暦）

const formatterCache = new Map();

function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** 指定したタイムゾーンでの年月日・時分秒・曜日（0 = 日曜）。 */
export function zonedParts(ms, timeZone) {
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    parts[part.type] = part.value;
  }
  const hour = Number(parts.hour) % 24;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

function dayNumber(parts) {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY);
}

export function pad(value, width) {
  return String(value).padStart(width, '0');
}

/** 暦日を表すキー（yyyy-MM-dd）。 */
export function dayKey(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}`;
}

// MARK: - 表記

/** 24 時間表記で、時は 0 を付けない（例: 3:46、23:05）。 */
export function timeLabel(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${p.hour}:${pad(p.minute, 2)}`;
}

/** 一覧の日時欄。同じ暦日は H:mm、前日は「昨日」、2〜6 日前は曜日、それより前は M/d か yyyy/M/d。 */
export function listLabel(ms, nowMs, timeZone) {
  const d = zonedParts(ms, timeZone);
  const n = zonedParts(nowMs, timeZone);
  const daysAgo = dayNumber(n) - dayNumber(d);
  if (daysAgo === 0) return `${d.hour}:${pad(d.minute, 2)}`;
  if (daysAgo === 1) return '昨日';
  if (daysAgo >= 2 && daysAgo <= 6) return `${WEEKDAYS[d.weekday]}曜日`;
  if (d.year === n.year) return `${d.month}/${d.day}`;
  return `${d.year}/${d.month}/${d.day}`;
}

/**
 * 会話内の日付区切り。本物と同じく、今日と昨日は「今日」「昨日」、同じ年は「10/19(月)」、
 * 年が異なれば「2019年12月16日(月)」（2026-11-11 に所有者のスクリーンショットで確認。Swift 版は古い表記のまま）。
 */
export function separatorLabel(ms, nowMs, timeZone) {
  const d = zonedParts(ms, timeZone);
  const n = zonedParts(nowMs, timeZone);
  const daysAgo = dayNumber(n) - dayNumber(d);
  if (daysAgo === 0) return '今日';
  if (daysAgo === 1) return '昨日';
  const weekday = WEEKDAYS[d.weekday];
  return d.year === n.year ? `${d.month}/${d.day}(${weekday})` : `${d.year}年${d.month}月${d.day}日(${weekday})`;
}

/** グループ名の末尾の人数（例: 「グループ名 (12)」の「 (12)」）を分ける。長い名前を省略しても人数は残すため。 */
export function splitMemberCount(displayName) {
  const match = /^(.*\S)(\s*\([\d,]+\))$/u.exec(displayName);
  return match ? { name: match[1], count: match[2] } : { name: displayName, count: null };
}

// MARK: - ダミー日時の生成

/** T0 を分単位で切り下げた表示基準時刻 A。 */
export function baseTime(startedAt) {
  return Math.floor(startedAt / MINUTE) * MINUTE;
}

/**
 * ダミーの時刻を置く時間帯（2026-11-11 の所有者の指示。Swift 版は昔の計算のまま）。どのメッセージも 8:00〜22:59 に収める。
 * 開いた時刻からさかのぼるとき、23 時から翌朝 8 時までは数えず、さかのぼる長さを 15/24 に縮める。
 * 縮めるので、何日前・何年前かはほぼ変わらない（1 日前は前の日の同じ時刻）。夜に開いたときは、その夜の 23 時から数える。
 * 最初の 5 分（MINIMUM_LATEST_OFFSET_SECONDS）だけは縮めないので、最新は必ず開いた時刻の 5 分以上前になる。
 */
export const ACTIVE_HOURS = Object.freeze({ start: 8, end: 23 });
const HOUR = 3_600_000;
const ACTIVE_START = ACTIVE_HOURS.start * HOUR;
const ACTIVE_END = ACTIVE_HOURS.end * HOUR;
const ACTIVE_SPAN = ACTIVE_END - ACTIVE_START;
const offsetCache = new Map();

/** その瞬間の、UTC からの時差（ミリ秒）。 */
function zoneOffset(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - (ms - (ms % 1000));
}

/** 暦日（その日の 0 時の壁時計を UTC とみなしたミリ秒）の昼の時差。夏時間の切り替えは夜なので、8〜23 時はこの値になる。 */
function dayOffset(dayWall, timeZone) {
  const key = `${timeZone} ${dayWall}`;
  let offset = offsetCache.get(key);
  if (offset === undefined) {
    const noon = dayWall + 12 * HOUR;
    offset = zoneOffset(noon - zoneOffset(noon, timeZone), timeZone);
    if (offsetCache.size >= 10_000) offsetCache.clear();
    offsetCache.set(key, offset);
  }
  return offset;
}

/** 基準時刻 base の seconds 秒前にあたるダミーの時刻（ACTIVE_HOURS の説明のとおりに夜を飛ばす）。 */
export function dummyDate(base, seconds, timeZone) {
  const ms = seconds * 1000;
  const exact = MINIMUM_LATEST_OFFSET_SECONDS * 1000;
  let rest = Math.round(Math.min(ms, exact) + Math.max(0, ms - exact) * (ACTIVE_SPAN / DAY));
  const p = zonedParts(base, timeZone);
  let day = Date.UTC(p.year, p.month - 1, p.day);
  let cursor = ((p.hour * 60 + p.minute) * 60 + p.second) * 1000;
  if (cursor <= ACTIVE_START) {
    day -= DAY;
    cursor = ACTIVE_END;
  } else {
    cursor = Math.min(cursor, ACTIVE_END);
  }
  let wall;
  if (rest <= cursor - ACTIVE_START) {
    wall = day + cursor - rest;
  } else {
    rest -= cursor - ACTIVE_START;
    const daysBack = Math.ceil(rest / ACTIVE_SPAN);
    wall = day - daysBack * DAY + ACTIVE_END - (rest - (daysBack - 1) * ACTIVE_SPAN);
  }
  return wall - dayOffset(Math.floor(wall / DAY) * DAY, timeZone);
}

/** グループの発言者のアイコン。名前ごとに catalog.memberAvatars で決める（無い人は頭文字で表示する）。 */
function senderAvatar(name, memberAvatars) {
  return name && Object.hasOwn(memberAvatars, name) ? memberAvatars[name] : null;
}

/** グループの人数（名前の末尾の「 (12)」）。1 対 1 とオープンチャットは null。 */
function groupMemberCount(template) {
  if (template.openChat) return null;
  const { count } = splitMemberCount(template.displayName);
  return count ? Number(count.replace(/\D/gu, '')) : null;
}

function renderThread(template, base, timeZone, memberAvatars) {
  const members = groupMemberCount(template);
  const messages = template.messages.map((message) => ({
    id: message.id,
    sender: message.sender,
    text: message.text,
    senderName: message.senderName ?? null,
    senderAvatar: senderAvatar(message.senderName, memberAvatars),
    // グループで自分が送ったものは、本物と同じく「既読 10」のように読んだ人数を出す（指定が無ければ自分以外の全員）。
    readCount: message.sender === 'me' && members ? (message.readCount ?? Math.max(1, members - 1)) : null,
    date: dummyDate(base, template.latestOffsetSeconds + message.secondsBeforeLatest, timeZone),
  }));
  if (messages.length === 0) return null;
  return {
    id: template.id,
    displayName: template.displayName,
    avatarAsset: template.avatarAsset,
    isMuted: Boolean(template.muted),
    isOpenChat: Boolean(template.openChat),
    messages,
    latest: messages[messages.length - 1],
  };
}

const byLatest = (a, b) => b.latest.date - a.latest.date || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 新規起動または本当の前面復帰 1 回分の表示データ。最新メッセージ日時の降順に並べる。 */
export function makeSession({ id, catalog, startedAt, timeZone }) {
  const base = baseTime(startedAt);
  const threads = catalog.threads
    .map((template) => renderThread(template, base, timeZone, catalog.memberAvatars ?? {}))
    .filter(Boolean)
    .sort(byLatest);
  const pinned = [catalog.pinnedContact, ...(catalog.extraPinnedContacts ?? [])];
  return { id, startedAt, baseTime: base, timeZone, pinned, threads };
}

// MARK: - 本物の通知の反映

/** 反映の設定の初期値。新しい相手も表示し、相手ごとの選択（choices）で表示・非表示を決める。 */
export const DEFAULT_LIVE_SETTINGS = { enabled: true, showNew: true, choices: {} };

/** その相手を反映するか。相手ごとの選択があればそれに従い、無ければ「新しい相手も表示」に従う。 */
export function liveContactShown(contact, settings = DEFAULT_LIVE_SETTINGS) {
  if (settings.enabled === false) return false;
  return settings.choices?.[contact.key] ?? settings.showNew !== false;
}

function liveMessages(contact) {
  return contact.messages
    .filter((message) => typeof message.text === 'string' && Number.isFinite(message.date))
    .map((message) => ({
      id: `live-${message.id}`,
      sender: message.sender === 'me' ? 'me' : 'other',
      text: message.text,
      senderName: null,
      date: message.date,
    }))
    .sort((a, b) => a.date - b.date);
}

/**
 * ダミーのセッションに、本物のメッセージ（1 対 1 の相手ごと）を合成する。元のセッションは変えない。
 * - 固定相手: 本物があれば会話（thread）を付ける。無ければ今までどおり本文なし。
 * - 既存の相手: 自分の送信を含む本物（トーク履歴を取り込んだ相手）なら本物だけにする。受信だけなら、
 *   ダミーの会話を本物の最初のメッセージの 1 日以上前へ置き直し、古い履歴として残す。
 * - どの行にも当たらない相手: 新しい行として足す（アイコンは頭文字）。
 * 本物の日時は絶対時刻のまま使い、開くたびに動かさない。
 */
export function applyLive(session, live, settings = DEFAULT_LIVE_SETTINGS) {
  if (!session || !live?.contacts?.length || settings.enabled === false) return session;
  const byThread = new Map();
  const extra = [];
  for (const contact of live.contacts) {
    if (!liveContactShown(contact, settings)) continue;
    const messages = liveMessages(contact);
    if (messages.length === 0) continue;
    if (contact.threadId) byThread.set(contact.threadId, messages);
    else extra.push({ contact, messages });
  }
  if (byThread.size === 0 && extra.length === 0) return session;

  const pinned = session.pinned.map((contact) => {
    const messages = byThread.get(contact.id);
    if (!messages) return contact;
    const thread = {
      id: contact.id,
      displayName: contact.displayName,
      avatarAsset: contact.avatarAsset,
      isMuted: false,
      isOpenChat: false,
      messages,
      latest: messages[messages.length - 1],
    };
    return { ...contact, thread };
  });

  const threads = session.threads.map((thread) => {
    const real = byThread.get(thread.id);
    if (!real) return thread;
    let messages = real;
    if (!real.some((message) => message.sender === 'me')) {
      const shift = Math.min(0, real[0].date - DAY - thread.latest.date);
      messages = [...thread.messages.map((message) => ({ ...message, date: message.date + shift })), ...real];
    }
    return { ...thread, messages, latest: messages[messages.length - 1] };
  });
  for (const { contact, messages } of extra) {
    threads.push({
      id: `live-${contact.key}`,
      displayName: contact.name,
      avatarAsset: null,
      isMuted: false,
      isOpenChat: false,
      messages,
      latest: messages[messages.length - 1],
    });
  }
  threads.sort(byLatest);
  return { ...session, pinned, threads };
}

/** 会話画面の行。日付が変わるところに区切りを入れ、送り手の切り替わりをグループの先頭にする。 */
export function detailItems(thread, nowMs, timeZone) {
  const items = [];
  let previous = null;
  for (const message of thread.messages) {
    const key = dayKey(message.date, timeZone);
    const startsNewDay = !previous || dayKey(previous.date, timeZone) !== key;
    if (startsNewDay) {
      items.push({ type: 'separator', id: `separator-${key}`, label: separatorLabel(message.date, nowMs, timeZone) });
    }
    const startsGroup = startsNewDay
      || previous.sender !== message.sender
      || (previous.senderName ?? null) !== (message.senderName ?? null);
    items.push({
      type: 'message',
      id: `message-${message.id}`,
      message,
      startsGroup,
      timeLabel: timeLabel(message.date, timeZone),
    });
    previous = message;
  }
  return items;
}

// MARK: - 起動と復帰の判定

/**
 * 画面の表示状態から「新規起動」と「バックグラウンドからの本当の復帰」だけを取り出す。
 * phase は 'active'（表示）、'inactive'、'background'（非表示）。
 */
export class ForegroundEventDetector {
  constructor() {
    this.hasBeenActive = false;
    this.passedBackground = false;
  }

  consume(phase) {
    if (phase === 'background') {
      this.passedBackground = true;
      return null;
    }
    if (phase !== 'active') return null;
    const kind = !this.hasBeenActive ? 'launch' : this.passedBackground ? 'resume' : null;
    this.hasBeenActive = true;
    this.passedBackground = false;
    return kind;
  }
}

// MARK: - 起動ログの書式（native 版と同じ TSV）

export const LOG_HEADER = ['日時', '種別', 'イベントID', 'アプリ版', 'タイムゾーン'].join('\t');
export const KIND_LABEL = { launch: '起動', resume: '復帰' };

/** 例: 2026-10-19T10:00:18.427+09:00。UTC でも Z ではなく +00:00。 */
export function timestamp(ms, timeZone) {
  const millis = ((ms % 1000) + 1000) % 1000;
  const whole = ms - millis;
  const p = zonedParts(whole, timeZone);
  const offsetMinutes = Math.round(
    (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole) / MINUTE,
  );
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}T${pad(p.hour, 2)}:${pad(p.minute, 2)}:`
    + `${pad(p.second, 2)}.${pad(millis, 3)}${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
}

function sanitize(value) {
  return String(value).replace(/[\t\r\n]/g, ' ');
}

export function logLine(event) {
  return [
    timestamp(event.detectedAt, event.timeZone),
    KIND_LABEL[event.kind] ?? event.kind,
    String(event.id).toLowerCase(),
    sanitize(event.appVersion),
    sanitize(event.timeZone),
  ].join('\t');
}

/** 記録の月（yyyy-MM）。イベント自身の時刻とタイムゾーンで決める。 */
export function monthKey(event) {
  const p = zonedParts(event.detectedAt, event.timeZone);
  return `${pad(p.year, 4)}-${pad(p.month, 2)}`;
}

/** 書き出し用のテキスト。古い順に並べ、ヘッダーを 1 行目に置く。 */
export function exportText(events) {
  const sorted = [...events].sort((a, b) => a.detectedAt - b.detectedAt);
  return [LOG_HEADER, ...sorted.map(logLine)].join('\n') + '\n';
}

/**
 * 記録の画面の表示。新しい順に並べ、記録したときの暦日ごとにまとめる。
 * 時刻は記録したときのタイムゾーンで出し、いまの端末と違うときだけそのタイムゾーン名を添える。
 */
export function logDays(events, nowMs, timeZone) {
  const n = zonedParts(nowMs, timeZone);
  const days = [];
  for (const event of [...events].sort((a, b) => b.detectedAt - a.detectedAt)) {
    const d = zonedParts(event.detectedAt, event.timeZone);
    const key = `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`;
    if (days.at(-1)?.key !== key) {
      const daysAgo = dayNumber(n) - dayNumber(d);
      const date = `${d.year === n.year ? '' : `${d.year}年`}${d.month}月${d.day}日（${WEEKDAYS[d.weekday]}）`;
      const label = daysAgo === 0 ? `今日・${date}` : daysAgo === 1 ? `昨日・${date}` : date;
      days.push({ key, label, rows: [] });
    }
    days.at(-1).rows.push({
      id: event.id,
      time: `${d.hour}:${pad(d.minute, 2)}:${pad(d.second, 2)}`,
      kind: event.kind,
      kindLabel: KIND_LABEL[event.kind] ?? event.kind,
      timeZone: event.timeZone === timeZone ? '' : event.timeZone,
    });
  }
  return days;
}

// MARK: - 同梱データの検証（Swift の CatalogValidator と同じ規則。extraPinnedContacts と memberAvatars は PWA 版だけが使う）

export const MINIMUM_LATEST_OFFSET_SECONDS = 300;

export function validateCatalog(catalog) {
  const issues = [];
  const blank = (value) => typeof value !== 'string' || value.trim() === '';
  if (catalog.schemaVersion !== 1) issues.push(`schemaVersion ${catalog.schemaVersion} には対応していません`);
  const pinned = catalog.pinnedContact ?? {};
  for (const field of ['id', 'displayName', 'avatarAsset']) {
    if (blank(pinned[field])) issues.push(`pinnedContact.${field} が空です`);
  }
  const pinnedIDs = new Set([pinned.id]);
  for (const [index, contact] of (catalog.extraPinnedContacts ?? []).entries()) {
    for (const field of ['id', 'displayName', 'avatarAsset']) {
      if (blank(contact[field])) issues.push(`extraPinnedContacts[${index}].${field} が空です`);
    }
    if (pinnedIDs.has(contact.id)) issues.push(`固定相手の ID ${contact.id} が重複しています`);
    pinnedIDs.add(contact.id);
  }
  const memberAvatars = catalog.memberAvatars ?? {};
  if (typeof memberAvatars !== 'object' || Array.isArray(memberAvatars)) {
    issues.push('memberAvatars は {"名前": "画像名"} の形にしてください');
  } else {
    for (const [name, asset] of Object.entries(memberAvatars)) {
      if (blank(name) || blank(asset)) issues.push(`memberAvatars の「${name}」の名前か画像名が空です`);
    }
  }
  const threads = Array.isArray(catalog.threads) ? catalog.threads : [];
  if (threads.length === 0) issues.push('threads が空です');

  const seenThreadIDs = new Set();
  const offsets = new Map();
  for (const thread of threads) {
    if (blank(thread.id)) issues.push('ID が空のトークがあります');
    if (seenThreadIDs.has(thread.id)) issues.push(`トーク ID ${thread.id} が重複しています`);
    seenThreadIDs.add(thread.id);
    if (pinnedIDs.has(thread.id)) issues.push(`トーク ID ${thread.id} が固定相手の ID と同じです`);
    if (blank(thread.displayName)) issues.push(`トーク ${thread.id} の displayName が空です`);
    if (blank(thread.avatarAsset)) issues.push(`トーク ${thread.id} の avatarAsset が空です`);
    if (!(thread.latestOffsetSeconds >= MINIMUM_LATEST_OFFSET_SECONDS)) {
      issues.push(`トーク ${thread.id} の latestOffsetSeconds は ${MINIMUM_LATEST_OFFSET_SECONDS} 以上にしてください`);
    }
    offsets.set(thread.latestOffsetSeconds, [...(offsets.get(thread.latestOffsetSeconds) ?? []), thread.id]);

    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    if (messages.length === 0) {
      issues.push(`トーク ${thread.id} にメッセージがありません`);
      continue;
    }
    const seenMessageIDs = new Set();
    let previous = null;
    for (const message of messages) {
      if (blank(message.id)) issues.push(`トーク ${thread.id} に ID が空のメッセージがあります`);
      else if (seenMessageIDs.has(message.id)) issues.push(`トーク ${thread.id} のメッセージ ID ${message.id} が重複しています`);
      seenMessageIDs.add(message.id);
      if (message.sender !== 'me' && message.sender !== 'other') {
        issues.push(`トーク ${thread.id} のメッセージ ${message.id} の sender は me か other にしてください`);
      }
      if (blank(message.text)) issues.push(`トーク ${thread.id} のメッセージ ${message.id} の本文が空です`);
      if (message.readCount !== undefined && (message.sender !== 'me' || !Number.isInteger(message.readCount) || message.readCount < 1)) {
        issues.push(`トーク ${thread.id} のメッセージ ${message.id} の readCount は、自分のメッセージに 1 以上の整数で付けてください`);
      }
      if (message.secondsBeforeLatest < 0) issues.push(`トーク ${thread.id} のメッセージ ${message.id} の secondsBeforeLatest が負です`);
      if (previous && message.secondsBeforeLatest >= previous.secondsBeforeLatest) {
        issues.push(`トーク ${thread.id} のメッセージ ${message.id} は直前より secondsBeforeLatest を小さくしてください`);
      }
      previous = message;
    }
    const last = messages[messages.length - 1];
    if (last.secondsBeforeLatest !== 0) issues.push(`トーク ${thread.id} の最後のメッセージの secondsBeforeLatest は 0 にしてください`);
    if (last.sender !== 'other') issues.push(`トーク ${thread.id} の最後のメッセージは相手（other）からにしてください`);
  }
  for (const [offset, ids] of offsets) {
    if (ids.length > 1) issues.push(`latestOffsetSeconds ${offset} が複数のトーク（${ids.join(', ')}）で同じです`);
  }
  return issues;
}
