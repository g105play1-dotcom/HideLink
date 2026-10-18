import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@anonlink/shared';
import type { Request } from 'express';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AppError } from '../common/app-error.js';
import { SESSION_COOKIE_NAME, clientAddress, parseCookieHeader } from '../common/cookies.js';
import { isOriginAllowed } from '../common/origin.js';
import { RateLimitService } from '../common/rate-limit.service.js';
import { IdentityService } from './identity.service.js';
import { ANONYMOUS_ROUTE, type RequestWithIdentity } from './request-context.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The single HTTP request guard, applied globally.
 *
 * It performs, in a fixed order:
 *  1. **Origin check** — state-changing requests must come from an allow-listed
 *     origin (the second layer of CSRF defence, after `SameSite=Lax`).
 *  2. **Identity resolution** — the session cookie is turned into an identity.
 *     A banned identity is rejected here, so no endpoint has to remember to check.
 *  3. **Rate limiting** — keyed by identity when known, by client address otherwise.
 *  4. **Authorisation** — authentication is required unless the route opted out
 *     with `@Anonymous()`.
 *
 * Doing all four in one place means there is exactly one code path to audit, and
 * a newly added endpoint is protected by default.
 */
@Injectable()
export class RequestGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identityService: IdentityService,
    private readonly rateLimit: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithIdentity>();

    // 1. Origin policy.
    if (!SAFE_METHODS.has(request.method.toUpperCase())) {
      if (!isOriginAllowed(request.headers.origin, this.config.CORS_ORIGINS)) {
        throw new AppError(ErrorCode.FORBIDDEN_ORIGIN);
      }
    }

    // 2. Identity resolution.
    const cookies = parseCookieHeader(request.headers.cookie);
    const identity = await this.identityService.identify(cookies[SESSION_COOKIE_NAME]);

    if (identity) {
      if (identity.banned) throw new AppError(ErrorCode.IDENTITY_BANNED);
      request.identity = identity;
      this.identityService.touch(identity);
    }

    // 3. Rate limiting.
    const address = clientAddress(
      request.headers,
      request.socket?.remoteAddress,
      this.config.TRUST_PROXY,
    );
    this.rateLimit.enforce(
      'http',
      identity ? `identity:${identity.userId}` : `address:${address ?? 'unknown'}`,
    );

    // 4. Authorisation.
    const anonymous =
      this.reflector.getAllAndOverride<boolean>(ANONYMOUS_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    if (!anonymous && !identity) throw new AppError(ErrorCode.IDENTITY_REQUIRED);

    return true;
  }
}

/** Reads the client address for the current request (used by session bootstrap). */
export function requestAddress(request: Request, config: AppConfig): string | undefined {
  return clientAddress(request.headers, request.socket?.remoteAddress, config.TRUST_PROXY);
}
