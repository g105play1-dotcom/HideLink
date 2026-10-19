import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Res } from '@nestjs/common';
import {
  ErrorCode,
  adminSessionSchema,
  type AdminSessionInput,
  type AdminStatusView,
} from '@anonlink/shared';
import type { Response } from 'express';

import { AppError } from '../common/app-error.js';
import { ADMIN_COOKIE_NAME, serializeClearedCookie, serializeCookie } from '../common/cookies.js';
import { zodBody } from '../common/zod-validation.pipe.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { Anonymous } from '../identity/request-context.js';
import { isOwnerKeyValid } from './admin.guard.js';

/** How long an admin session cookie lasts. Short: the owner can always enter the key again. */
const ADMIN_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/**
 * Opening and closing the owner's session.
 *
 * Separate from `AdminController` because these two routes must be reachable *without*
 * the key (or with it in the body rather than a cookie). Keeping them in their own class
 * means every route on the guarded class is protected by default, so a route added later
 * cannot be left open by forgetting a decorator.
 */
@Controller('admin')
@Anonymous()
export class AdminSessionController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Whether the owner surface is configured at all.
   *
   * The answer is a single boolean and reveals nothing else, which is why it may be
   * asked without the key: the page has to be able to say "архив выключен" instead of
   * showing a form that can only fail.
   */
  @Get('status')
  status(): AdminStatusView {
    return { available: Boolean(this.config.ADMIN_TOKEN) };
  }

  /**
   * Exchanges the key for an `HttpOnly` cookie.
   *
   * The point is that the key does not have to live in the browser's storage, where any
   * script could read it. It is validated here exactly as the guard validates it, so a
   * wrong key never sets a cookie.
   */
  @Post('session')
  @HttpCode(204)
  open(
    @Body(zodBody(adminSessionSchema)) body: AdminSessionInput,
    @Res({ passthrough: true }) response: Response,
  ): void {
    if (!this.config.ADMIN_TOKEN) throw new AppError(ErrorCode.ROUTE_NOT_FOUND);
    if (!isOwnerKeyValid(this.config.ADMIN_TOKEN, body.token)) {
      throw new AppError(ErrorCode.ADMIN_AUTH_REQUIRED);
    }

    response.setHeader(
      'Set-Cookie',
      serializeCookie(ADMIN_COOKIE_NAME, body.token, {
        httpOnly: true,
        secure: this.config.COOKIE_SECURE,
        // Stricter than the user session: nothing legitimate sends this cookie cross-site.
        sameSite: 'Strict',
        maxAgeSeconds: ADMIN_SESSION_MAX_AGE_SECONDS,
      }),
    );
  }

  /** Closes the owner's session. Safe to call when there never was one. */
  @Delete('session')
  @HttpCode(204)
  close(@Res({ passthrough: true }) response: Response): void {
    response.setHeader(
      'Set-Cookie',
      serializeClearedCookie(ADMIN_COOKIE_NAME, {
        secure: this.config.COOKIE_SECURE,
        sameSite: 'Strict',
      }),
    );
  }
}
