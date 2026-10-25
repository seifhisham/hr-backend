import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import {
  derive,
  passwordHash,
  tokenHash,
} from '../common/security/credentials.js';
import { newTotpSecret, seal, unseal, totpCounter } from './owner-crypto.js';
import type { CreateCompany, OwnerLogin, OwnerSetup } from './owner.dto.js';

export type OwnerIdentity = {
  id: string;
  name: string;
  email: string;
  recoveryUsed?: boolean;
};
@Injectable()
export class OwnerService implements OnModuleDestroy {
  private readonly pool = new Pool({
    connectionString: process.env.HR_PG_URL,
    connectionTimeoutMillis: 5000,
    max: 4,
  });
  constructor() {
    this.pool.on('error', () =>
      console.error('Platform database connection interrupted'),
    );
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
  private async query<T>(sql: string, values: unknown[]): Promise<T> {
    try {
      return (await this.pool.query<{ value: T }>(sql, values)).rows[0].value;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : '';
      if (/^HR(400|401|404|409|429)$/.test(code)) {
        const message = (error as Error).message;
        throw new HttpException(message, Number(code.slice(2)));
      }
      if (code === '23505')
        throw new ConflictException(
          'Company code or request ID already exists.',
        );
      throw new ServiceUnavailableException(
        'Platform operation could not be completed. Refresh before retrying.',
      );
    }
  }
  async authenticate(token: string) {
    if (!/^owner_[A-Za-z0-9_-]{43}$/.test(token))
      throw new UnauthorizedException('Please sign in as platform owner.');
    const owner = await this.query<OwnerIdentity | null>(
      'SELECT hr_owner_session($1) AS value',
      [tokenHash(token)],
    );
    if (!owner)
      throw new UnauthorizedException('Please sign in as platform owner.');
    return owner;
  }
  async login(input: OwnerLogin) {
    const credential = await this.query<{
      passwordHash: string;
      secret: string;
    } | null>('SELECT hr_owner_credentials($1) AS value', [input.email]);
    const stored =
      credential?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const [salt, expected] = stored.split(':');
    const derived = (await derive(input.password, salt, 64)) as Buffer;
    const valid = timingSafeEqual(derived, Buffer.from(expected, 'hex'));
    const counter =
      credential && valid && input.code
        ? totpCounter(unseal(credential.secret), input.code)
        : null;
    const recovery =
      valid && input.recoveryCode
        ? tokenHash(input.recoveryCode.toLowerCase())
        : null;
    const token = 'owner_' + randomBytes(32).toString('base64url');
    const owner = await this.query<OwnerIdentity | null>(
      'SELECT hr_owner_login($1,$2,$3,$4,$5) AS value',
      [input.email, valid ? stored : '', counter, recovery, tokenHash(token)],
    );
    if (!owner)
      throw new UnauthorizedException(
        'Invalid owner email, password or verification code.',
      );
    return { owner, token };
  }
  async prepareSetup(token: string) {
    const result = await this.query<{
      email: string;
      name: string;
      secret: string;
    }>('SELECT hr_owner_setup($1,$2,$3) AS value', [
      tokenHash(token),
      'prepare',
      { secret: seal(newTotpSecret()) },
    ]);
    const secret = unseal(result.secret);
    return {
      email: result.email,
      name: result.name,
      secret,
      authenticatorUri: `otpauth://totp/${encodeURIComponent('HR Platform:' + result.email)}?secret=${secret}&issuer=HR%20Platform&algorithm=SHA1&digits=6&period=30`,
    };
  }
  async completeSetup(input: OwnerSetup) {
    const pending = await this.query<{ secret: string }>(
      'SELECT hr_owner_setup($1,$2,$3) AS value',
      [tokenHash(input.token), 'prepare', {}],
    );
    if (!pending.secret)
      throw new BadRequestException('Prepare authenticator setup first.');
    const counter = totpCounter(unseal(pending.secret), input.code);
    if (counter === null) {
      await this.query('SELECT hr_owner_setup($1,$2,$3) AS value', [
        tokenHash(input.token),
        'fail',
        {},
      ]);
      throw new UnauthorizedException('Invalid authenticator code.');
    }
    const recoveryCodes = Array.from({ length: 10 }, () =>
      randomBytes(12).toString('hex'),
    );
    const result = await this.query<{ email: string }>(
      'SELECT hr_owner_setup($1,$2,$3) AS value',
      [
        tokenHash(input.token),
        'complete',
        {
          expectedSecret: pending.secret,
          name: input.name,
          passwordHash: await passwordHash(input.password),
          counter,
          recoveryHashes: recoveryCodes.map(tokenHash),
        },
      ],
    );
    return {
      ...result,
      recoveryCodes,
      message:
        'Save these recovery codes privately. Wait for the next authenticator code, then sign in.',
    };
  }
  command<T = unknown>(token: string, operation: string, p: unknown = {}) {
    const command = ['companies', 'branch-limit'].includes(operation)
      ? 'hr_owner_branch_limits'
      : 'hr_owner_command';
    return this.query<T>(`SELECT ${command}($1,$2,$3) AS value`, [
      tokenHash(token),
      operation,
      p,
    ]);
  }
  async createCompany(token: string, input: CreateCompany) {
    const schedules = [false, true].map((sales) => ({
      id: randomUUID(),
      name: sales ? 'Sales workweek' : 'Standard workweek',
      start: sales ? '11:00' : '10:00',
      end: sales ? '19:00' : '18:00',
      days: [0, 1, 2, 3, 4],
      graceMinutes: 15,
    }));
    return this.command(token, 'create', {
      ...input,
      fingerprint: tokenHash(JSON.stringify(input)),
      id: randomUUID(),
      branchId: randomUUID(),
      schedules,
    });
  }
  async invitation(token: string, companyId: string, requestId: string) {
    const invitationToken = randomBytes(32).toString('base64url');
    const result = await this.command<{ cipher: string; expiresAt: string }>(
      token,
      'invitation',
      {
        companyId,
        requestId,
        hash: tokenHash(invitationToken),
        cipher: seal(invitationToken),
      },
    );
    return {
      path: '/onboarding#token=' + unseal(result.cipher),
      expiresAt: result.expiresAt,
    };
  }
  async recovery(
    token: string,
    input: { password: string; code?: string; recoveryCode?: string },
  ) {
    const owner = await this.authenticate(token);
    const confirmed = await this.login({ ...input, email: owner.email });
    try {
      const setupToken = randomBytes(32).toString('base64url');
      const result = await this.command<{ expiresAt: string }>(
        confirmed.token,
        'recover',
        { hash: tokenHash(setupToken) },
      );
      return { ...result, path: '/owner/setup#token=' + setupToken };
    } finally {
      await this.command(confirmed.token, 'logout');
    }
  }
  async invitationPreview(token: string) {
    return this.query('SELECT hr_company_invitation($1,$2,$3) AS value', [
      tokenHash(token),
      'preview',
      {},
    ]);
  }
  async acceptInvitation(input: {
    token: string;
    password: string;
    name: string;
    branchName: string;
    policy: unknown;
  }) {
    // Hash outside the locked transaction; the invitation and company are revalidated on consumption.
    const result = await this.query(
      'SELECT hr_company_invitation($1,$2,$3) AS value',
      [
        tokenHash(input.token),
        'accept',
        {
          name: input.name,
          branchName: input.branchName,
          policy: input.policy,
          userId: randomUUID(),
          passwordHash: await passwordHash(input.password),
        },
      ],
    );
    return result;
  }
}
