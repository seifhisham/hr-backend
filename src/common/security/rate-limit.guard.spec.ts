import { type ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimit, RateLimitGuard, RATE_LIMITS } from './rate-limit.guard.js';

function context(
  bucket: keyof typeof RATE_LIMITS,
  id = 'account-one',
  companyId = 'company-one',
) {
  class Route {
    @RateLimit(bucket)
    handler(this: void) {}
  }
  const headers = new Map<string, string>();
  return {
    headers,
    execution: {
      getHandler: () => Route.prototype.handler,
      switchToHttp: () => ({
        getRequest: () => ({ actor: { id, companyId } }),
        getResponse: () => ({
          setHeader: (key: string, value: string) => headers.set(key, value),
        }),
      }),
    } as unknown as ExecutionContext,
  };
}

afterEach(() => vi.restoreAllMocks());

it.each(Object.keys(RATE_LIMITS) as (keyof typeof RATE_LIMITS)[])(
  'enforces the %s budget, isolates accounts/categories, and resets at expiry',
  (bucket) => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const guard = new RateLimitGuard(new Reflector());
    const route = context(bucket);
    const policy = RATE_LIMITS[bucket];
    for (let i = 0; i < policy.requests; i++)
      expect(guard.canActivate(route.execution)).toBe(true);
    now += 1;
    try {
      guard.canActivate(route.execution);
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
    }
    expect(route.headers.get('Retry-After')).toBe(
      String(policy.windowMs / 1000),
    );
    expect(guard.canActivate(context(bucket, 'account-two').execution)).toBe(
      true,
    );
    const other = bucket === 'exports' ? 'reports' : 'exports';
    expect(guard.canActivate(context(other).execution)).toBe(true);
    // Blocked requests must not move the window forward.
    now = 1_000_000 + policy.windowMs;
    expect(guard.canActivate(route.execution)).toBe(true);
  },
);

it('does not require an actor or consume budget for unmarked routes', () => {
  const guard = new RateLimitGuard(new Reflector());
  const execution = {
    getHandler: () => () => {},
    switchToHttp: () => {
      throw new Error('Not needed');
    },
  } as unknown as ExecutionContext;
  expect(guard.canActivate(execution)).toBe(true);
});

it('isolates identical account IDs belonging to different companies', () => {
  const guard = new RateLimitGuard(new Reflector());
  const route = context('exports', 'same-account', 'company-one');
  for (let index = 0; index < RATE_LIMITS.exports.requests; index++)
    guard.canActivate(route.execution);
  expect(() => guard.canActivate(route.execution)).toThrow(HttpException);
  expect(
    guard.canActivate(
      context('exports', 'same-account', 'company-two').execution,
    ),
  ).toBe(true);
});
