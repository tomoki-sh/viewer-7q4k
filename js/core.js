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

/** 会話内の日付区切り。同じ年は「10/19(月)」、年が異なれば「2026/12/23(水)」。 */
export function separatorLabel(ms, nowMs, timeZone) {
  const d = zonedParts(ms, timeZone);
  const n = zonedParts(nowMs, timeZone);
  const monthDay = `${d.month}/${d.day}(${WEEKDAYS[d.weekday]})`;
  return d.year === n.year ? monthDay : `${d.year}/${monthDay}`;
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

function renderThread(template, base) {
  const latestDate = base - template.latestOffsetSeconds * 1000;
  const messages = template.messages.map((message) => ({
    id: message.id,
    sender: message.sender,
    text: message.text,
    senderName: message.senderName ?? null,
    date: latestDate - message.secondsBeforeLatest * 1000,
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

/** 新規起動または本当の前面復帰 1 回分の表示データ。最新メッセージ日時の降順に並べる。 */
export function makeSession({ id, catalog, startedAt, timeZone }) {
  const base = baseTime(startedAt);
  const threads = catalog.threads
    .map((template) => renderThread(template, base))
    .filter(Boolean)
    .sort((a, b) => b.latest.date - a.latest.date || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pinned = [catalog.pinnedContact, ...(catalog.extraPinnedContacts ?? [])];
  return { id, startedAt, baseTime: base, timeZone, pinned, threads };
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

// MARK: - 同梱データの検証（Swift の CatalogValidator と同じ規則。extraPinnedContacts は PWA 版だけが使う）

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
