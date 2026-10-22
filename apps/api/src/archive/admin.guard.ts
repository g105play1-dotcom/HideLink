import { createHash, timingSafeEqual } from 'node:crypto';

import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '@anonlink/shared';
import type { Request } from 'express';

import { AppError } from '../common/app-error.js';
import { ADMIN_COOKIE_NAME, parseCookieHeader } from '../common/cookies.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';

/**
 * The owner boundary.
 *
 * ## Why this exists at all
 *
 * AnonLink has no accounts: users are anonymous identities, and there is deliberately no
 * way to log in as one. The owner, however, needs to read the archive and set its policy.
 * That is a *different* kind of principal, so it gets a different credential — a secret
 * key that exists only in the server's environment and in the owner's browser, never in
 * the database and never in a User ID.
 *
 * ## Fail closed
 *
 *  - No key configured means the surface does not exist: the guard answers `404`, exactly
 *    as if the routes had never been mounted. An installation that never opted in cannot
 *    be attacked through a door that was never built.
 *  - The comparison hashes both sides first. `timingSafeEqual` throws on different
 *    lengths, and comparing raw strings would leak a prefix match through timing.
 *
 * ## The seam for moderator accounts
 *
 * This class is the only place that decides *who may enter* `/admin`. When accounts arrive,
 * replacing this guard with one that resolves an account and attaches its id is the change;
 * every route already goes through it, and the moderation services take an explicit target
 * and reason rather than assuming a credential. The missing piece will be attribution: an
 * append-only audit row per action, written with the account id. Until then `ADMIN_TOKEN`
 * means the owner and nobody else, and a ban cannot be attributed to a person (D36).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.ADMIN_TOKEN) throw new AppError(ErrorCode.ROUTE_NOT_FOUND);

    const request = context.switchToHttp().getRequest<Request>();
    if (!isOwnerKeyValid(this.config.ADMIN_TOKEN, ownerKeyFromRequest(request))) {
      throw new AppError(ErrorCode.ADMIN_AUTH_REQUIRED);
    }

    return true;
  }
}

/** The owner key as presented: a bearer header, or the admin cookie. */
export function ownerKeyFromRequest(request: Request): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const value = header.slice('Bearer '.length).trim();
    if (value.length > 0) return value;
  }

  const cookies = parseCookieHeader(request.headers.cookie);
  return cookies[ADMIN_COOKIE_NAME] ?? null;
}

/** Constant-time comparison of the configured key with the presented one. */
export function isOwnerKeyValid(configured: string | undefined, presented: string | null): boolean {
  if (!configured || !presented) return false;

  const expected = createHash('sha256').update(configured).digest();
  const actual = createHash('sha256').update(presented).digest();
  return timingSafeEqual(expected, actual);
}
