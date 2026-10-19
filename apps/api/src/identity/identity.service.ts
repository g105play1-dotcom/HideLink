import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode, generatePublicId, type IdentitySettingsView } from '@anonlink/shared';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AppError } from '../common/app-error.js';
import { newSessionToken, optionalSaltHash, sha256Hex } from '../common/ids.js';
import { log } from '../common/logger.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  IDENTITY_SETTINGS_SELECT,
  preferencesToColumns,
  profileToColumns,
  toSettingsView,
  type IdentitySettingsData,
  type SettingsUpdateCommand,
} from './settings.mapper.js';

/**
 * The authenticated principal behind a request or a socket.
 *
 * `publicId` is safe to show and to send over the wire. `userId` is internal and
 * must never leave the server.
 */
export interface AuthenticatedIdentity {
  userId: string;
  publicId: string;
  sessionId: string;
  identityCreatedAt: Date;
  /** Absolute expiry of the session that authenticated this request. */
  sessionExpiresAt: Date;
  /**
   * The identity's own settings: privacy, declared profile and search filters.
   *
   * Carried on the authenticated identity because every surface that needs them (the
   * REST views and the `session:ready` handshake) has already resolved the session, and
   * a second read of the same row would only add a way for the two to disagree.
   */
  settings: IdentitySettingsView;
  banned: boolean;
}

export interface SessionMeta {
  /** Raw client address; hashed (when a salt is configured) before storage. */
  address?: string;
  userAgent?: string;
}

export interface IssuedSession {
  identity: AuthenticatedIdentity;
  /** Raw bearer token. Written to the HttpOnly cookie and never persisted. */
  token: string;
  expiresAt: Date;
}

/** Contact details for a lookup by User ID. */
export interface PublicUserLookup {
  publicId: string;
  exists: boolean;
  acceptsRequests: boolean;
}

const UNIQUE_VIOLATION = 'P2002';
/** Prisma's "record to update not found". An identity deleted mid-request. */
const MISSING_RECORD = 'P2025';
/** How often `lastSeenAt` / `lastUsedAt` may be written for one session. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

/**
 * Anonymous identities and their sessions.
 *
 * The security model in one paragraph: an identity is created without any
 * credential; the *only* thing that proves ownership is a 256-bit random session
 * token delivered in an HttpOnly cookie. The database stores just its SHA-256
 * digest, so the row is useless to an attacker who exfiltrates it, and the token
 * is unreachable from JavaScript, so an XSS cannot steal it either. The public
 * User ID is deliberately *not* accepted as proof of ownership anywhere.
 */
@Injectable()
export class IdentityService {
  private readonly lastTouchAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get sessionTtlMs(): number {
    return this.config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  get sessionTtlSeconds(): number {
    return this.config.SESSION_TTL_DAYS * 24 * 60 * 60;
  }

  /**
   * Creates a fresh anonymous identity together with its first session.
   *
   * The public ID is generated with a CSPRNG and a unique index backs it, so a
   * (vanishingly unlikely) collision is retried rather than surfacing to the user.
   */
  async createIdentity(meta: SessionMeta = {}): Promise<IssuedSession> {
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);
    const ipHash = optionalSaltHash(meta.address, this.config.ABUSE_HASH_SALT);
    const userAgentHash = optionalSaltHash(meta.userAgent, this.config.ABUSE_HASH_SALT);

    // Collisions are practically impossible; the loop exists so that a bug or a
    // future change to the ID format degrades gracefully instead of failing hard.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const publicId = generatePublicId();
      const token = newSessionToken();

      try {
        const created = await this.prisma.identity.create({
          data: {
            publicId,
            sessions: {
              create: { tokenHash: sha256Hex(token), expiresAt, ipHash, userAgentHash },
            },
          },
          select: {
            id: true,
            publicId: true,
            createdAt: true,
            sessions: { select: { id: true }, take: 1 },
            ...IDENTITY_SETTINGS_SELECT,
          },
        });

        const session = created.sessions[0];
        if (!session) throw new Error('session row missing after create');

        log.info('identity.created', { attempt });

        return {
          identity: {
            userId: created.id,
            publicId: created.publicId,
            sessionId: session.id,
            identityCreatedAt: created.createdAt,
            sessionExpiresAt: expiresAt,
            settings: toSettingsView(created),
            banned: false,
          },
          token,
          expiresAt,
        };
      } catch (error) {
        if (isUniqueViolation(error)) {
          log.warn('identity.public_id_collision', { attempt });
          continue;
        }
        throw error;
      }
    }

    throw new AppError(ErrorCode.INTERNAL_ERROR, 'Could not allocate a User ID.');
  }

  /**
   * Resolves a raw session token to an identity.
   *
   * Returns `null` for anything that is not a live session. Distinguishing
   * "unknown token" from "expired" is not useful to a client and would leak
   * whether a token ever existed, so both collapse into `null`.
   */
  async identify(token: string | undefined): Promise<AuthenticatedIdentity | null> {
    if (!token) return null;

    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
      select: {
        id: true,
        revokedAt: true,
        expiresAt: true,
        identity: {
          select: {
            id: true,
            publicId: true,
            createdAt: true,
            bannedAt: true,
            ...IDENTITY_SETTINGS_SELECT,
          },
        },
      },
    });

    if (!session) return null;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;

    const identity = session.identity;

    return {
      userId: identity.id,
      publicId: identity.publicId,
      sessionId: session.id,
      identityCreatedAt: identity.createdAt,
      sessionExpiresAt: session.expiresAt,
      settings: toSettingsView(identity),
      banned: identity.bannedAt !== null,
    };
  }

  /**
   * Revokes every existing session and issues a brand-new identity.
   *
   * This is the "get a new User ID" action: it is intentionally destructive, which
   * is what makes it a usable panic button after a bad conversation.
   */
  async rotate(current: AuthenticatedIdentity, meta: SessionMeta = {}): Promise<IssuedSession> {
    await this.prisma.session.updateMany({
      where: { identityId: current.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    log.security('identity.rotated', {});
    return this.createIdentity(meta);
  }

  /** Revokes the sessions of one identity, e.g. on logout. */
  async revokeAll(userId: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { identityId: userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /**
   * Records activity, at most once per {@link TOUCH_INTERVAL_MS} per session.
   *
   * Fire-and-forget on purpose: liveness bookkeeping must never add latency to, or
   * fail, a user-facing request. Writes of its own failures are logged, not thrown.
   */
  touch(identity: AuthenticatedIdentity, now = Date.now()): void {
    const previous = this.lastTouchAt.get(identity.sessionId) ?? 0;
    if (now - previous < TOUCH_INTERVAL_MS) return;
    this.lastTouchAt.set(identity.sessionId, now);

    void (async () => {
      try {
        await this.prisma.$transaction([
          this.prisma.session.update({
            where: { id: identity.sessionId },
            data: { lastUsedAt: new Date(now) },
          }),
          this.prisma.identity.update({
            where: { id: identity.userId },
            data: { lastSeenAt: new Date(now) },
          }),
        ]);
      } catch (error) {
        // A failed touch must never affect the caller.
        log.warn('identity.touch_failed', { sessionId: identity.sessionId });
        void error;
      }
    })();
  }

  /**
   * Looks up whether a User ID exists and whether it accepts direct requests.
   *
   * Deliberately returns *no* presence information: exposing "online now" would
   * turn this endpoint into a tracking oracle for any User ID. Whether the person
   * can actually be reached is reported by the connection request itself.
   */
  async lookupByPublicId(publicId: string): Promise<PublicUserLookup> {
    const found = await this.prisma.identity.findUnique({
      where: { publicId },
      select: { publicId: true, incomingRequests: true },
    });

    if (!found) return { publicId, exists: false, acceptsRequests: false };

    return {
      publicId: found.publicId,
      exists: true,
      acceptsRequests: found.incomingRequests === 'everyone',
    };
  }

  /**
   * Applies an already-validated settings change and returns the resulting settings.
   *
   * Merging and validating happen in the controller, which is the only place that sees
   * both the stored values and the request (see `SettingsUpdateCommand`). This method
   * writes and reports what it wrote, nothing more.
   */
  async updateSettings(
    userId: string,
    update: SettingsUpdateCommand,
  ): Promise<IdentitySettingsView | null> {
    const data: IdentitySettingsData = {
      ...(update.incomingRequests ? { incomingRequests: update.incomingRequests } : {}),
      // A boolean cannot be tested for truthiness: `blockingEnabled: false` is a real
      // value the user asked for, not "absent".
      ...(update.blockingEnabled !== undefined ? { blockingEnabled: update.blockingEnabled } : {}),
      ...(update.profile ? profileToColumns(update.profile) : {}),
      ...(update.search ? preferencesToColumns(update.search) : {}),
    };

    if (Object.keys(data).length === 0) {
      const current = await this.prisma.identity.findUnique({
        where: { id: userId },
        select: IDENTITY_SETTINGS_SELECT,
      });
      return current ? toSettingsView(current) : null;
    }

    try {
      const updated = await this.prisma.identity.update({
        where: { id: userId },
        data,
        select: IDENTITY_SETTINGS_SELECT,
      });
      return toSettingsView(updated);
    } catch (error) {
      if (isMissingRecord(error)) return null;
      throw error;
    }
  }

  /** Cleanup hook: drops touch bookkeeping for sessions that are gone. */
  forgetSession(sessionId: string): void {
    this.lastTouchAt.delete(sessionId);
  }

  /** Diagnostics for the maintenance job. */
  touchCacheSize(): number {
    return this.lastTouchAt.size;
  }
}

/** True when a Prisma error is a unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/** True when a Prisma error says the record being changed no longer exists. */
function isMissingRecord(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === MISSING_RECORD
  );
}
