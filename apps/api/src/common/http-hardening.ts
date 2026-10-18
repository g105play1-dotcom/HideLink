import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';

import { APP_CONFIG, type AppConfig } from '../config/env.js';

/**
 * Baseline hardening headers for every API response.
 *
 * The API only ever returns JSON, so most HTML-oriented header sets would be
 * noise. What matters here:
 *  - `X-Content-Type-Options: nosniff` stops a browser from second-guessing the
 *    declared content type;
 *  - `X-Frame-Options: DENY` and `Cross-Origin-Opener-Policy` prevent the API from
 *    being framed or windowed into an attack page;
 *  - `Referrer-Policy: no-referrer` keeps User IDs out of third-party referrers;
 *  - `Cache-Control: no-store` keeps identity-bearing responses out of any cache;
 *  - removing `X-Powered-By` avoids advertising the framework version.
 *
 * `Strict-Transport-Security` is only sent in production, where TLS is expected:
 * sending it from a plain-HTTP development server would break local browsing.
 *
 * (Written directly rather than through `helmet`: Express 5 compatibility plus one
 * fewer dependency to keep current.)
 */
@Injectable()
export class SecurityHeadersInterceptor implements NestInterceptor {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const response = context.switchToHttp().getResponse<Response>();

    response.removeHeader('X-Powered-By');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    response.setHeader('Cache-Control', 'no-store');

    if (this.config.isProduction) {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    return next.handle();
  }
}
