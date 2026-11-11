// 暗号化した同梱データ（data.bin）の読み込み。
//
// 書式: "DCB1"(4 バイト) | PBKDF2 の反復回数（4 バイト、ビッグエンディアン） | salt(16) | iv(12) | 暗号文 + 認証タグ
// 鍵はパスコードから PBKDF2-SHA256 で作り、AES-256-GCM で復号する。

const MAGIC = 'DCB1';

export function parseBundle(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  if (magic !== MAGIC || bytes.length < 36 + 16) {
    throw new Error('データの形式が正しくありません');
  }
  const iterations = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, false);
  return {
    iterations,
    salt: bytes.slice(8, 24),
    iv: bytes.slice(24, 36),
    data: bytes.slice(36),
  };
}

export async function deriveKeyBytes(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase.normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export async function decryptBundle(parsed, keyBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: parsed.iv }, key, parsed.data);
  return JSON.parse(new TextDecoder().decode(plain));
}

export function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
