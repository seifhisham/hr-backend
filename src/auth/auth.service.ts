import {
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import {
  derive,
  passwordHash,
  tokenHash,
} from '../common/security/credentials.js';
import type { Actor } from '../common/types/actor.type.js';
import { DatabaseService } from '../database/database.service.js';
import type { User } from './types/user.type.js';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}
  private get db() {
    return this.store.db;
  }

  async login(email: string, password: string) {
    const now = Date.now();
    const limit = this.db
      .prepare('SELECT failures, reset_at FROM login_limits WHERE email = ?')
      .get(email) as { failures: number; reset_at: number } | undefined;
    if (limit && limit.reset_at > now && limit.failures >= 5)
      throw new HttpException(
        'Too many attempts. Try again in 15 minutes.',
        429,
      );
    let user = this.db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email) as User | undefined;
    const stored =
      user?.password_hash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const [salt, expected] = stored.split(':');
    const actual = (await derive(password, salt, 64)) as Buffer;
    // A reset or deactivation may happen while password verification yields.
    user = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      User | undefined;
    if (
      !user ||
      !user.active ||
      user.password_hash !== stored ||
      !timingSafeEqual(actual, Buffer.from(expected, 'hex'))
    ) {
      this.db
        .prepare(
          `INSERT INTO login_limits VALUES (?, 1, ?) ON CONFLICT(email) DO UPDATE SET
        failures = CASE WHEN reset_at <= ? THEN 1 ELSE failures + 1 END,
        reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END`,
        )
        .run(email, now + 900000, now, now);
      throw new UnauthorizedException('Invalid email or password');
    }
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM login_limits WHERE email = ?').run(email);
    this.db
      .prepare('DELETE FROM sessions WHERE expires <= ?')
      .run(new Date().toISOString());
    this.store.transaction(() => {
      this.db
        .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
        .run(
          tokenHash(token),
          user.id,
          new Date(now + 12 * 3600000).toISOString(),
        );
      this.auditService.record(
        this.actor(user),
        'account.signed_in',
        user.id,
        null,
        null,
      );
    });
    return { token, user: this.actor(user) };
  }

  authenticate(token: string): Actor {
    const user = this.db
      .prepare(
        'SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.hash = ? AND s.expires > ? AND u.active = 1',
      )
      .get(tokenHash(token), new Date().toISOString()) as User | undefined;
    if (!user) throw new UnauthorizedException('Please sign in');
    return this.actor(user);
  }

  logout(token: string) {
    const actor = this.authenticate(token);
    this.store.transaction(() => {
      this.db
        .prepare('DELETE FROM sessions WHERE hash = ?')
        .run(tokenHash(token));
      this.auditService.record(
        actor,
        'account.signed_out',
        actor.id,
        null,
        null,
      );
    });
  }

  private actor(user: User): Actor {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      employeeId: user.employee_id,
    };
  }

  async changePassword(
    actor: Actor,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(actor.id) as User;
    const [salt, expected] = user.password_hash.split(':');
    const actual = (await derive(currentPassword, salt, 64)) as Buffer;
    if (!timingSafeEqual(actual, Buffer.from(expected, 'hex')))
      throw new UnauthorizedException('Current password is incorrect');
    const hash = await passwordHash(newPassword);
    this.store.transaction(() => {
      this.db
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(hash, actor.id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(actor.id);
      this.auditService.record(
        actor,
        'account.password_changed',
        actor.id,
        null,
        null,
      );
    });
    return { message: 'Password changed. Sign in again.' };
  }
}
