import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  searchPreferencesSchema,
  settingsSchema,
  userLookupParamsSchema,
  type CurrentSessionView,
  type SessionView,
  type SettingsUpdate,
  type UserLookupView,
} from '@anonlink/shared';
import type { Request, Response } from 'express';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import {
  SESSION_COOKIE_NAME,
  clientAddress,
  parseCookieHeader,
  serializeCookie,
} from '../common/cookies.js';
import { RateLimitService } from '../common/rate-limit.service.js';
import { zodBody, zodParam } from '../common/zod-validation.pipe.js';
import { DirectoryService } from '../directory/directory.service.js';
import { IdentityService, type AuthenticatedIdentity } from './identity.service.js';
import { Anonymous, CurrentIdentity } from './request-context.js';

/**
 * Identity and session endpoints.
 *
 * The flow is intentionally tiny: the browser calls `POST /session` once on load,
 * and from then on the HttpOnly cookie is the only credential. There is no sign-up,
 * no password and no email — and therefore nothing to phish.
 */
@Controller('session')
export class IdentityController {
  constructor(
    private readonly identityService: IdentityService,
    private readonly rateLimit: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Ensures the caller has an identity.
   *
   * Idempotent: an existing, valid session is returned untouched, so the web app
   * can call this on every load without creating identities in a loop.
   */
  @Post()
  @Anonymous()
  async bootstrap(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionView> {
    const cookies = parseCookieHeader(request.headers.cookie);
    const existing = await this.identityService.identify(cookies[SESSION_COOKIE_NAME]);
    if (existing) return this.toView(existing);

    // Only actual creations consume the (address-keyed) creation budget.
    const address = clientAddress(
      request.headers,
      request.socket?.remoteAddress,
      this.config.TRUST_PROXY,
    );
    this.rateLimit.enforce('sessionCreate', `address:${address ?? 'unknown'}`);

    const issued = await this.identityService.createIdentity({
      address,
      userAgent: request.headers['user-agent'],
    });

    this.writeSessionCookie(response, issued.token);
    return this.toView(issued.identity);
  }

  /** Reports whether the caller already has an identity, without creating one. */
  @Get()
  @Anonymous()
  async current(@Req() request: Request): Promise<CurrentSessionView> {
    const cookies = parseCookieHeader(request.headers.cookie);
    const identity = await this.identityService.identify(cookies[SESSION_COOKIE_NAME]);
    return identity
      ? { authenticated: true, session: this.toView(identity) }
      : { authenticated: false, session: null };
  }

  /**
   * "Get a new User ID": revokes every session of the current identity and issues
   * a brand-new one. Destructive by design — it is the panic button after a bad
   * conversation, and the previous User ID immediately stops working.
   */
  @Delete()
  async rotate(
    @CurrentIdentity() identity: AuthenticatedIdentity,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionView> {
    const issued = await this.identityService.rotate(identity, {
      address: clientAddress(
        request.headers,
        request.socket?.remoteAddress,
        this.config.TRUST_PROXY,
      ),
      userAgent: request.headers['user-agent'],
    });

    this.writeSessionCookie(response, issued.token);
    return this.toView(issued.identity);
  }

  private toView(identity: AuthenticatedIdentity): SessionView {
    return {
      publicId: identity.publicId,
      createdAt: identity.identityCreatedAt.toISOString(),
      sessionExpiresAt: identity.sessionExpiresAt.toISOString(),
      settings: identity.settings,
    };
  }

  private writeSessionCookie(response: Response, token: string): void {
    response.setHeader(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE_NAME, token, {
        maxAgeSeconds: this.identityService.sessionTtlSeconds,
        httpOnly: true,
        secure: this.config.COOKIE_SECURE,
        sameSite: 'Lax',
        path: '/',
        domain: this.config.COOKIE_DOMAIN,
      }),
    );
  }
}

/**
 * Everything about *other* users, plus the caller's own preferences.
 */
@Controller()
export class UsersController {
  constructor(
    private readonly identityService: IdentityService,
    private readonly rateLimit: RateLimitService,
    private readonly directory: DirectoryService,
  ) {}

  /**
   * Resolves a User ID typed by the user.
   *
   * A miss is a normal outcome, not an error, so it answers `200` with
   * `exists: false` — that keeps the web client from having to treat a routine
   * negative result as a failure.
   *
   * Note what is *not* returned: account age, internal id, ban state, or whether
   * anybody is currently online. Any of those would turn this endpoint into an
   * oracle. Reachability is reported by the connection request itself, addressed
   * to exactly one user at a time, and rate limited.
   */
  @Get('users/:publicId')
  async lookup(
    @CurrentIdentity() identity: AuthenticatedIdentity,
    // No property name: Nest then hands the pipe the whole params object, which is
    // what `userLookupParamsSchema` validates. `@Param('publicId', pipe)` would pass
    // the bare string instead and every lookup would fail validation.
    @Param(zodParam(userLookupParamsSchema)) params: { publicId: string },
  ): Promise<UserLookupView> {
    // Keyed by the caller so one identity cannot enumerate the ID space.
    this.rateLimit.enforce('lookup', `identity:${identity.userId}`);

    if (params.publicId === identity.publicId) {
      return { publicId: params.publicId, exists: true, acceptsRequests: true };
    }

    return this.identityService.lookupByPublicId(params.publicId);
  }

  /** Updates the caller's own settings. */
  @Patch('me/settings')
  async updateSettings(
    @CurrentIdentity() identity: AuthenticatedIdentity,
    @Body(zodBody(settingsSchema)) settings: SettingsUpdate,
  ): Promise<SessionView> {
    // Filters are merged with the stored ones and validated *as a pair* before anything
    // is written. `ageMin` and `ageMax` only mean something together, so a request that
    // moves one bound has to be checked against the stored value of the other —
    // validating the fragment alone would accept `ageMin: 40` on top of a stored
    // `ageMax: 30` and leave the user with a filter nobody could ever satisfy.
    const search = settings.search
      ? searchPreferencesSchema.parse({ ...identity.settings.search, ...settings.search })
      : undefined;

    const updated = await this.identityService.updateSettings(identity.userId, {
      ...(settings.incomingRequests ? { incomingRequests: settings.incomingRequests } : {}),
      ...(settings.profile ? { profile: settings.profile } : {}),
      ...(search ? { search } : {}),
    });

    // The guard already proved this identity exists, so the write cannot have missed.
    if (!updated) return this.toView(identity);

    // Keep the matchmaker's synchronous view in step with what was just written. Without
    // this, a new filter (or a new "не принимать заявки") would only take effect after
    // the next reconnect — the classic "saved but ignored" setting.
    this.directory.patch(identity.userId, {
      incomingRequests: updated.incomingRequests,
      profile: updated.profile,
      preferences: updated.search,
    });

    return {
      publicId: identity.publicId,
      createdAt: identity.identityCreatedAt.toISOString(),
      sessionExpiresAt: identity.sessionExpiresAt.toISOString(),
      settings: updated,
    };
  }

  private toView(identity: AuthenticatedIdentity): SessionView {
    return {
      publicId: identity.publicId,
      createdAt: identity.identityCreatedAt.toISOString(),
      sessionExpiresAt: identity.sessionExpiresAt.toISOString(),
      settings: identity.settings,
    };
  }
}
