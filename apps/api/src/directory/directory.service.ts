import { Inject, Injectable } from '@nestjs/common';
import type {
  DeclaredProfile,
  IncomingRequestPolicy,
  MatchSide,
  SearchPreferences,
} from '@anonlink/shared';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { log } from '../common/logger.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  IDENTITY_SETTINGS_SELECT,
  toDeclaredProfile,
  toSearchPreferences,
} from '../identity/settings.mapper.js';

/**
 * Synchronous in-memory view of the handful of per-identity facts that the
 * matchmaker needs *inside* its critical section.
 *
 * ## Why this exists
 *
 * Matchmaking must be atomic: two users must never be assigned to each other
 * twice, and nobody may be dropped from the queue during a race. Any `await`
 * inside the "pick a peer" step would open a window for another event to
 * interleave and hand out the same peer. Blocking is a database question, so
 * without a cache it would force exactly such an `await`.
 *
 * `DirectoryService` removes that `await`: facts are loaded once, before the
 * critical section, and every question the matchmaker asks afterwards is answered
 * synchronously from memory.
 *
 * ## Correctness argument
 *
 * Blocks between `a` and `b` are always visible from `a`'s own records, because
 * `load()` fetches both directions (`blockerId = a` *and* `blockedId = a`).
 * So `isBlockedBetween(a, b)` needs only `a` to be loaded, and matchmaking always
 * loads the identity that is acting. That is why one-sided loading is safe here.
 *
 * ## Freshness
 *
 * Facts are refreshed when an identity opens a socket (`refresh`), so stale data
 * lives at most as long as a connection. Local mutations (blocking, changing the
 * request policy, banning, editing the profile or the filters) update the cache
 * immediately, so no operation ever observes its own stale write.
 *
 * ## Why filters need *both* sides loaded
 *
 * `isBlockedBetween(a, b)` is answerable from `a`'s records alone, but a filter is a
 * mutual question: `a`'s filters must accept `b` *and* `b`'s must accept `a`. So
 * `mutuallyCompatible` requires facts for both identities and returns `false` when
 * either is missing. That fails closed on purpose — an unknown candidate is never
 * matched with someone who asked for a specific kind of partner — and it is safe,
 * because a ticket only exists for an identity that was loaded when it queued and
 * `refresh()` runs on every reconnect.
 */
export interface IdentityFacts {
  readonly userId: string;
  readonly publicId: string;
  readonly banned: boolean;
  readonly incomingRequests: IncomingRequestPolicy;
  /**
   * Whether this identity wants the "block a peer" action at all.
   *
   * Carried here because the block action is refused in the chat domain, which runs
   * inside the matchmaking critical section and must not `await` a database read.
   * Existing blocks are unaffected by it — see docs/DECISIONS.md D24.
   */
  readonly blockingEnabled: boolean;
  /** Voluntary, self-declared data. Never shown to a peer; only feeds filters. */
  readonly profile: DeclaredProfile;
  readonly preferences: SearchPreferences;
}

@Injectable()
export class DirectoryService {
  private readonly facts = new Map<string, IdentityFacts>();
  private readonly blockedByMe = new Map<string, Set<string>>();
  private readonly blockingMe = new Map<string, Set<string>>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** True when nothing is known about the identity yet. */
  isLoaded(userId: string): boolean {
    return this.facts.has(userId);
  }

  /** Loads facts for `userId` unless already cached. Safe to await concurrently. */
  async ensureLoaded(userId: string): Promise<void> {
    if (this.isLoaded(userId)) return;

    const existing = this.inFlight.get(userId);
    if (existing) return existing;

    const promise = this.load(userId).finally(() => this.inFlight.delete(userId));
    this.inFlight.set(userId, promise);
    return promise;
  }

  /** Forces a reload. Used when a socket connects, to bound staleness. */
  async refresh(userId: string): Promise<void> {
    this.forget(userId);
    await this.ensureLoaded(userId);
  }

  /** Drops cached facts (last socket closed, identity removed, …). */
  forget(userId: string): void {
    this.facts.delete(userId);
    this.blockedByMe.delete(userId);
    this.blockingMe.delete(userId);
  }

  get(userId: string): IdentityFacts | undefined {
    return this.facts.get(userId);
  }

  isBanned(userId: string): boolean {
    return this.facts.get(userId)?.banned ?? false;
  }

  acceptsIncomingRequests(userId: string): boolean {
    return (this.facts.get(userId)?.incomingRequests ?? 'everyone') === 'everyone';
  }

  /**
   * Whether the user wants the block action available.
   *
   * Mirrors the database default for an unknown identity, exactly like
   * {@link acceptsIncomingRequests}: the caller has already loaded the facts, so `true`
   * here would mean "nothing was cached", and refusing a safety action because of a cache
   * miss would be the wrong failure.
   */
  blockingAllowed(userId: string): boolean {
    return this.facts.get(userId)?.blockingEnabled ?? true;
  }

  /**
   * Whether a chat between `a` and `b` is forbidden by a block in *either*
   * direction. Requires `a` to be loaded; see the class comment.
   */
  isBlockedBetween(a: string, b: string): boolean {
    if (this.blockedByMe.get(a)?.has(b)) return true;
    return this.blockingMe.get(a)?.has(b) ?? false;
  }

  /** Records a new block locally and keeps both parties' views consistent. */
  recordBlock(blockerId: string, blockedId: string): void {
    const blockerSide = this.blockedByMe.get(blockerId) ?? new Set<string>();
    blockerSide.add(blockedId);
    this.blockedByMe.set(blockerId, blockerSide);

    if (this.facts.has(blockedId) || this.blockedByMe.has(blockedId)) {
      const targetSide = this.blockingMe.get(blockedId) ?? new Set<string>();
      targetSide.add(blockerId);
      this.blockingMe.set(blockedId, targetSide);
    }
  }

  /** Removes a block locally. Returns `false` when it was not cached. */
  recordUnblock(blockerId: string, blockedId: string): boolean {
    return (
      (this.blockedByMe.get(blockerId)?.delete(blockedId) ?? false) ||
      (this.blockingMe.get(blockedId)?.delete(blockerId) ?? false)
    );
  }

  /** Updates cached facts after a local mutation (settings change, ban). */
  patch(
    userId: string,
    patch: Partial<
      Pick<
        IdentityFacts,
        'banned' | 'incomingRequests' | 'blockingEnabled' | 'profile' | 'preferences'
      >
    >,
  ): void {
    const current = this.facts.get(userId);
    if (!current) return;
    this.facts.set(userId, { ...current, ...patch });
  }

  /**
   * The two matchmaking sides of a potential pair, or `null` when either is unknown.
   *
   * The directory deliberately stops here: it *reads* facts, while deciding who may meet
   * whom (blocks, bans, relaxation stages, filters) is the chat service's job. Returning
   * the two sides in one call keeps the eligibility predicate down to a single lookup.
   *
   * Fails closed: an unknown side yields `null`, and the caller must treat that as "not
   * eligible" rather than as "no filters".
   */
  sides(a: string, b: string): { a: MatchSide; b: MatchSide } | null {
    const left = this.facts.get(a);
    const right = this.facts.get(b);
    if (!left || !right) return null;

    return {
      a: { profile: left.profile, preferences: left.preferences },
      b: { profile: right.profile, preferences: right.preferences },
    };
  }

  private async load(userId: string): Promise<void> {
    const [identity, blockedByMe, blockingMe] = await Promise.all([
      this.prisma.identity.findUnique({
        where: { id: userId },
        select: { id: true, publicId: true, bannedAt: true, ...IDENTITY_SETTINGS_SELECT },
      }),
      this.prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true } }),
      this.prisma.block.findMany({ where: { blockedId: userId }, select: { blockerId: true } }),
    ]);

    if (!identity) {
      log.warn('directory.identity_missing', { userId });
      this.forget(userId);
      return;
    }

    this.facts.set(userId, {
      userId: identity.id,
      publicId: identity.publicId,
      banned: identity.bannedAt !== null,
      incomingRequests: identity.incomingRequests,
      blockingEnabled: identity.blockingEnabled,
      profile: toDeclaredProfile(identity),
      preferences: toSearchPreferences(identity),
    });
    this.blockedByMe.set(userId, new Set(blockedByMe.map((row) => row.blockedId)));
    this.blockingMe.set(userId, new Set(blockingMe.map((row) => row.blockerId)));
  }

  /** Diagnostics only; never contains identifiers. */
  stats(): { identities: number; blockEdges: number; maxSocketsPerUser: number } {
    let blockEdges = 0;
    for (const set of this.blockedByMe.values()) blockEdges += set.size;
    return {
      identities: this.facts.size,
      blockEdges,
      maxSocketsPerUser: this.config.MAX_SOCKETS_PER_USER,
    };
  }
}
