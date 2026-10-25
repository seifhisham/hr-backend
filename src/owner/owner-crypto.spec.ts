import {
  newTotpSecret,
  seal,
  unseal,
  totp,
  totpCounter,
} from './owner-crypto.js';
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
it.each([
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
])('matches RFC 6238 SHA1 vector at %s', (seconds, expected) => {
  expect(totp(secret, Math.floor(Number(seconds) / 30), 8)).toBe(expected);
});
it('checks the current and adjacent time steps and rejects malformed or stale codes', () => {
  expect(totpCounter(secret, totp(secret, 100), 3000000)).toBe(100);
  expect(totpCounter(secret, totp(secret, 99), 3000000)).toBe(99);
  expect(totpCounter(secret, totp(secret, 98), 3000000)).toBeNull();
  expect(totpCounter(secret, '123', 3000000)).toBeNull();
  expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
});
it('encrypts authenticator secrets and detects tampering or a different key', () => {
  vi.stubEnv('HR_OWNER_ENCRYPTION_KEY', 'a'.repeat(64));
  const encrypted = seal(secret);
  expect(unseal(encrypted)).toBe(secret);
  expect(encrypted).not.toContain(secret);
  const bytes = Buffer.from(encrypted, 'base64url');
  bytes[20] ^= 1;
  expect(() => unseal(bytes.toString('base64url'))).toThrow();
  vi.stubEnv('HR_OWNER_ENCRYPTION_KEY', 'b'.repeat(64));
  expect(() => unseal(encrypted)).toThrow();
});
