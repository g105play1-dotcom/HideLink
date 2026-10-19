import { ErrorCode } from '@anonlink/shared';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/common/app-error.js';
import { RateLimitService, TokenBucket } from '../../src/common/rate-limit.service.js';
import type { AppConfig } from '../../src/config/env.js';

/**
 * The rate limiter, in isolation.
 *
 * The integration suites run with enormous budgets so that ordinary tests never trip a
 * limiter; the actual behaviour is therefore verified here, deterministically, by
 * passing an explicit clock instead of sleeping.
 */

const CONFIG = {
  RATE_LIMIT_HTTP_PER_MINUTE: 5,
  RATE_LIMIT_SESSION_CREATE_PER_HOUR: 4,
  RATE_LIMIT_CHAT_MESSAGES_PER_10S: 3,
  RATE_LIMIT_LOOKUP_PER_MINUTE: 6,
  RATE_LIMIT_CONNECT_REQUEST_PER_MINUTE: 2,
} as unknown as AppConfig;

const T0 = 1_700_000_000_000;

describe('TokenBucket', () => {
  it('allows a burst up to the capacity and then refuses', () => {
    const bucket = new TokenBucket(3, 60_000);
    const now = T0;

    expect(bucket.consume('k', now).allowed).toBe(true);
    expect(bucket.consume('k', now).allowed).toBe(true);
    expect(bucket.consume('k', now).allowed).toBe(true);

    const refused = bucket.consume('k', now);
    expect(refused.allowed).toBe(false);
    // The caller is told when to try again, so the client can show a countdown.
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('refills continuously rather than resetting on a boundary', () => {
    const bucket = new TokenBucket(60, 60_000); // one token per second
    const now = T0;

    for (let i = 0; i < 60; i += 1) expect(bucket.consume('k', now).allowed).toBe(true);
    expect(bucket.consume('k', now).allowed).toBe(false);

    // Half a second later there is not quite a whole token yet...
    expect(bucket.consume('k', now + 500).allowed).toBe(false);
    // ...and after a full second there is.
    expect(bucket.consume('k', now + 1_000).allowed).toBe(true);
  });

  it('never exceeds the capacity, however long the key has been idle', () => {
    const bucket = new TokenBucket(2, 60_000);
    const now = T0;

    bucket.consume('k', now);
    bucket.consume('k', now);

    // A year later the bucket is full again — not 500_000 tokens deep.
    const muchLater = now + 365 * 24 * 60 * 60 * 1_000;
    expect(bucket.consume('k', muchLater).allowed).toBe(true);
    expect(bucket.consume('k', muchLater).allowed).toBe(true);
    expect(bucket.consume('k', muchLater).allowed).toBe(false);
  });

  it('keeps the budget of one key independent of another', () => {
    const bucket = new TokenBucket(1, 60_000);
    const now = T0;

    expect(bucket.consume('alice', now).allowed).toBe(true);
    expect(bucket.consume('alice', now).allowed).toBe(false);
    // A different identity behind the same address is unaffected.
    expect(bucket.consume('bob', now).allowed).toBe(true);
  });

  it('forgets idle keys so memory cannot grow with the number of visitors', () => {
    const bucket = new TokenBucket(5, 60_000);
    const now = T0;

    bucket.consume('a', now);
    bucket.consume('b', now);
    expect(bucket.size).toBe(2);

    bucket.sweep(now + 60_001);
    expect(bucket.size).toBe(0);
  });

  it('drops the oldest keys when a flood would exceed the key budget', () => {
    // The safety valve that stops attacker-controlled keys from exhausting memory.
    const bucket = new TokenBucket(5, 60_000, 2);
    const now = T0;

    bucket.consume('a', now);
    bucket.consume('b', now);
    bucket.consume('c', now);

    expect(bucket.size).toBeLessThanOrEqual(2);
  });
});

describe('RateLimitService', () => {
  it('enforces each bucket with its own configured budget', () => {
    const service = new RateLimitService(CONFIG);
    const now = T0;

    expect(service.check('connectRequest', 'user-1', now).allowed).toBe(true);
    expect(service.check('connectRequest', 'user-1', now).allowed).toBe(true);
    expect(service.check('connectRequest', 'user-1', now).allowed).toBe(false);

    // A different bucket for the same user has not been touched.
    expect(service.check('lookup', 'user-1', now).allowed).toBe(true);
  });

  it('throws a client-safe 429 with the RATE_LIMITED code', () => {
    const service = new RateLimitService(CONFIG);
    const now = T0;

    service.enforce('chatMessage', 'user-1', now);
    service.enforce('chatMessage', 'user-1', now);
    service.enforce('chatMessage', 'user-1', now);

    try {
      service.enforce('chatMessage', 'user-1', now);
      throw new Error('the limiter did not engage');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe(ErrorCode.RATE_LIMITED);
      expect(appError.httpStatus).toBe(429);
      // The message is user-facing prose, not an internal detail.
      expect(appError.message).not.toContain('user-1');
    }
  });

  it('reports per-bucket key counts without any client data', () => {
    const service = new RateLimitService(CONFIG);
    service.check('http', 'user-1', T0);
    service.check('http', 'user-2', T0);

    const stats = service.stats();
    expect(stats).toEqual({
      http: 2,
      sessionCreate: 0,
      chatMessage: 0,
      lookup: 0,
      connectRequest: 0,
    });
  });

  it('sweeps every bucket', () => {
    const service = new RateLimitService(CONFIG);
    service.check('http', 'user-1', T0);
    service.check('lookup', 'user-1', T0);

    service.sweep(T0 + 3_600_001);

    expect(service.stats()).toEqual({
      http: 0,
      sessionCreate: 0,
      chatMessage: 0,
      lookup: 0,
      connectRequest: 0,
    });
  });
});
