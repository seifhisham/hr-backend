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
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, workspace?: string) {
    const companyId = await this.store.workspaceCompany(
      workspace ?? process.env.HR_DEFAULT_WORKSPACE ?? '',
    );
    if (!companyId)
      throw new UnauthorizedException('Invalid company, email or password');
    return this.store.withCompany(companyId, async () => {
      const now = Date.now();
      const limit = await this.store
        .prepare('SELECT failures,reset_at FROM login_limits WHERE email=?')
        .get(email);
      if (limit && Number(limit.reset_at) > now && Number(limit.failures) >= 5)
        throw new HttpException(
          'Too many attempts. Try again in 15 minutes.',
          429,
        );
      const user = (await this.store
        .prepare('SELECT * FROM users WHERE lower(email)=lower(?)')
        .get(email)) as User | undefined;
      const stored =
        user?.password_hash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`;
      const [salt, expected] = stored.split(':');
      const actual = (await derive(password, salt, 64)) as Buffer;
      const validPassword = timingSafeEqual(
        actual,
        Buffer.from(expected, 'hex'),
      );
      const result = await this.store.transaction(async () => {
        const current = (await this.store
          .prepare('SELECT * FROM users WHERE lower(email)=lower(?)')
          .get(email)) as User | undefined;
        if (
          !current ||
          !current.active ||
          current.password_hash !== stored ||
          !validPassword
        ) {
          await this.store
            .prepare(
              `INSERT INTO login_limits(email,failures,reset_at) VALUES(?,1,?)
            ON CONFLICT(company_id,email) DO UPDATE SET
              failures=CASE WHEN login_limits.reset_at<=? THEN 1 ELSE login_limits.failures+1 END,
              reset_at=CASE WHEN login_limits.reset_at<=? THEN excluded.reset_at ELSE login_limits.reset_at END`,
            )
            .run(email, now + 900000, now, now);
          return null;
        }
        const token = randomBytes(32).toString('base64url');
        await this.store
          .prepare('DELETE FROM login_limits WHERE email=?')
          .run(email);
        await this.store
          .prepare('DELETE FROM sessions WHERE expires<=?')
          .run(new Date().toISOString());
        await this.store
          .prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)')
          .run(
            tokenHash(token),
            current.id,
            new Date(now + 12 * 3600000).toISOString(),
          );
        const actor = this.actor(current);
        await this.audit.record(
          actor,
          'account.signed_in',
          current.id,
          null,
          null,
        );
        return { token, user: actor };
      });
      if (!result) throw new UnauthorizedException('Invalid email or password');
      return result;
    });
  }

  async authenticate(token: string): Promise<Actor> {
    const user = await this.store.sessionActor(
      tokenHash(token),
      new Date().toISOString(),
    );
    if (!user) throw new UnauthorizedException('Please sign in');
    return this.actor(user as unknown as User);
  }

  async logout(token: string) {
    const actor = await this.authenticate(token);
    await this.store.withCompany(actor.companyId, () =>
      this.store.transaction(async () => {
        await this.store
          .prepare('DELETE FROM sessions WHERE hash=?')
          .run(tokenHash(token));
        await this.audit.record(
          actor,
          'account.signed_out',
          actor.id,
          null,
          null,
        );
      }),
    );
  }

  private actor(
    user: Pick<
      User,
      'company_id' | 'id' | 'email' | 'name' | 'role' | 'employee_id'
    >,
  ): Actor {
    return {
      companyId: user.company_id,
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
    const user = (await this.store
      .prepare('SELECT * FROM users WHERE id=?')
      .get(actor.id)) as User;
    const [salt, expected] = user.password_hash.split(':');
    const actual = (await derive(currentPassword, salt, 64)) as Buffer;
    if (!timingSafeEqual(actual, Buffer.from(expected, 'hex')))
      throw new UnauthorizedException('Current password is incorrect');
    const hash = await passwordHash(newPassword);
    await this.store.transaction(async () => {
      const current = await this.store
        .prepare('SELECT active,password_hash FROM users WHERE id=?')
        .get(actor.id);
      if (!current?.active || current.password_hash !== user.password_hash)
        throw new UnauthorizedException('Your access changed. Sign in again.');
      await this.store
        .prepare('UPDATE users SET password_hash=? WHERE id=?')
        .run(hash, actor.id);
      await this.store
        .prepare('DELETE FROM sessions WHERE user_id=?')
        .run(actor.id);
      await this.audit.record(
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
