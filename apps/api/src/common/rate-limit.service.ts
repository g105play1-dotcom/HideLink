import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AppError } from './app-error.js';
import { ErrorCode } from '@anonlink/shared';

/**
 * In-process rate limiting based on token buckets.
 *
 * Why not `@nestjs/throttler`: the gateway needs the same mechanism for
 * WebSocket events, where Nest's HTTP guards do not apply. One small, tested
 * limiter used by both transports is easier to reason about than two different
 * ones, and it removes a dependency whose peer range has to match NestJS 12.
 *
 * Scope and limits (documented in docs/SECURITY.md):
 *  - State is per process. With several API instances each enforces its own
 *    budget, which is acceptable for the abuse levels this service targets.
 *  - Keys are derived from the authenticated identity where possible, so a single
 *    client behind a shared NAT address cannot exhaust everyone else's budget.
 */

export type RateLimitBucket =
  'http' | 'sessionCreate' | 'chatMessage' | 'lookup' | 'connectRequest' | 'ownerMessage';

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the next token is available. `0` when allowed. */
  retryAfterMs: number;
}

interface BucketState {
  tokens: number;
  updatedAt: number;
}

class TokenBucket {
  private readonly states = new Map<string, BucketState>();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    /** Guards against unbounded memory growth from attacker-controlled keys. */
    private readonly maxKeys = 20_000,
  ) {}

  private get refillPerMs(): number {
    return this.capacity / this.windowMs;
  }

  consume(key: string, now: number): RateLimitResult {
    const state = this.states.get(key) ?? { tokens: this.capacity, updatedAt: now };

    const elapsed = Math.max(0, now - state.updatedAt);
    state.tokens = Math.min(this.capacity, state.tokens + elapsed * this.refillPerMs);
    state.updatedAt = now;

    if (state.tokens >= 1) {
      state.tokens -= 1;
      this.states.set(key, state);
      this.evictIfNeeded(now);
      return { allowed: true, retryAfterMs: 0 };
    }

    this.states.set(key, state);
    const retryAfterMs = Math.ceil((1 - state.tokens) / this.refillPerMs);
    return { allowed: false, retryAfterMs };
  }

  /** Drops fully refilled entries; they carry no information any more. */
  sweep(now: number): void {
    for (const [key, state] of this.states) {
      if (now - state.updatedAt > this.windowMs) this.states.delete(key);
    }
  }

  get size(): number {
    return this.states.size;
  }

  private evictIfNeeded(now: number): void {
    if (this.states.size <= this.maxKeys) return;
    this.sweep(now);
    if (this.states.size <= this.maxKeys) return;

    // Still oversized: drop the oldest entries. This is a safety valve, not a
    // fairness mechanism, and it only triggers under sustained abuse.
    const overflow = this.states.size - this.maxKeys;
    let removed = 0;
    for (const key of this.states.keys()) {
      this.states.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }
}

@Injectable()
export class RateLimitService {
  private readonly buckets: Record<RateLimitBucket, TokenBucket>;
  private readonly config: AppConfig;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.config = config;
    this.buckets = {
      http: new TokenBucket(config.RATE_LIMIT_HTTP_PER_MINUTE, 60_000),
      sessionCreate: new TokenBucket(config.RATE_LIMIT_SESSION_CREATE_PER_HOUR, 3_600_000, 50_000),
      chatMessage: new TokenBucket(config.RATE_LIMIT_CHAT_MESSAGES_PER_10S, 10_000),
      lookup: new TokenBucket(config.RATE_LIMIT_LOOKUP_PER_MINUTE, 60_000),
      connectRequest: new TokenBucket(config.RATE_LIMIT_CONNECT_REQUEST_PER_MINUTE, 60_000),
      ownerMessage: new TokenBucket(
        config.RATE_LIMIT_OWNER_MESSAGE_PER_DAY,
        24 * 60 * 60 * 1000,
        50_000,
      ),
    };
  }

  check(bucket: RateLimitBucket, key: string, now = Date.now()): RateLimitResult {
    return this.buckets[bucket].consume(key, now);
  }

  /** Throws a client-safe {@link AppError} when the bucket is exhausted. */
  enforce(bucket: RateLimitBucket, key: string, now = Date.now()): void {
    const result = this.check(bucket, key, now);
    if (result.allowed) return;

    throw new AppError(ErrorCode.RATE_LIMITED, undefined, {
      httpStatus: 429,
      context: `retry-after-ms:${result.retryAfterMs}`,
    });
  }

  sweep(now = Date.now()): void {
    for (const bucket of Object.values(this.buckets)) bucket.sweep(now);
  }

  /** Diagnostics for the readiness endpoint; contains no client data. */
  stats(): Record<string, number> {
    return {
      http: this.buckets.http.size,
      sessionCreate: this.buckets.sessionCreate.size,
      chatMessage: this.buckets.chatMessage.size,
      lookup: this.buckets.lookup.size,
      connectRequest: this.buckets.connectRequest.size,
      ownerMessage: this.buckets.ownerMessage.size,
    };
  }
}

export { TokenBucket };
