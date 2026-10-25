import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() {
  const bytes = randomBytes(20);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return bits
    .match(/.{5}/g)!
    .map((chunk) => alphabet[parseInt(chunk, 2)])
    .join('');
}
export function totp(secret: string, counter: number, digits = 6) {
  let bits = '';
  for (const character of secret)
    bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  const key = Buffer.from(
    bits.match(/.{8}/g)!.map((chunk) => parseInt(chunk, 2)),
  );
  const moving = Buffer.alloc(8);
  moving.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(moving).digest();
  const value =
    (digest.readUInt32BE(digest.at(-1)! & 15) & 0x7fffffff) % 10 ** digits;
  return String(value).padStart(digits, '0');
}
export function totpCounter(secret: string, code: string, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const offset of [0, -1, 1])
    if (
      timingSafeEqual(
        Buffer.from(totp(secret, current + offset)),
        Buffer.from(code),
      )
    )
      return current + offset;
  return null;
}
function encryptionKey() {
  const key = process.env.HR_OWNER_ENCRYPTION_KEY;
  if (!key || !/^[a-f0-9]{64}$/i.test(key))
    throw new ServiceUnavailableException(
      'Owner encryption key is not configured.',
    );
  return Buffer.from(key, 'hex');
}
export function seal(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from('hr-platform-v1'));
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    'base64url',
  );
}
export function unseal(value: string) {
  try {
    const data = Buffer.from(value, 'base64url'),
      cipher = createDecipheriv(
        'aes-256-gcm',
        encryptionKey(),
        data.subarray(0, 12),
      );
    cipher.setAAD(Buffer.from('hr-platform-v1'));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      cipher.update(data.subarray(28)),
      cipher.final(),
    ]).toString('utf8');
  } catch {
    throw new ServiceUnavailableException(
      'Owner secrets could not be opened. Check the configured encryption key.',
    );
  }
}
