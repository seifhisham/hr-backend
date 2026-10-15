import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { AuthRequest } from '../../auth/types/auth-request.type.js';

export const RATE_LIMITS = {
  geocoding: { requests: 10, windowMs: 60_000 },
  reports: { requests: 60, windowMs: 60_000 },
  exports: { requests: 10, windowMs: 60_000 },
  photos: { requests: 10, windowMs: 60_000 },
  passwords: { requests: 5, windowMs: 900_000 },
} as const;
type Bucket = keyof typeof RATE_LIMITS;
const RATE_LIMIT_KEY = 'expensive_endpoint_limit';
export const RateLimit = (bucket: Bucket) =>
  SetMetadata(RATE_LIMIT_KEY, bucket);

@Injectable()
export class RateLimitGuard implements CanActivate {
  // shortcut: counters belong to one process and reset on restart; use shared storage before adding backend replicas.
  private readonly counters = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private nextCleanup = 0;

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const bucket = this.reflector.get<Bucket>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );
    if (!bucket) return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const now = Date.now();
    if (now >= this.nextCleanup) {
      for (const [key, counter] of this.counters) {
        if (counter.resetAt <= now) this.counters.delete(key);
      }
      this.nextCleanup = now + 60_000;
    }
    const policy = RATE_LIMITS[bucket];
    const key = `${req.actor.id}:${bucket}`;
    let counter = this.counters.get(key);
    if (!counter || counter.resetAt <= now) {
      counter = { count: 0, resetAt: now + policy.windowMs };
      this.counters.set(key, counter);
    }
    if (counter.count >= policy.requests) {
      const retryAfter = Math.ceil((counter.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        `Too many ${bucket} requests. Try again in ${retryAfter} seconds.`,
        429,
      );
    }
    counter.count++;
    return true;
  }
}
