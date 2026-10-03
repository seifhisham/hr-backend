import { createHash, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

export const derive = promisify(scrypt);

export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
