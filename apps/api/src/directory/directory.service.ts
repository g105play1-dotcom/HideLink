import { Inject, Injectable } from '@nestjs/common';
import type { IncomingRequestPolicy } from '@anonlink/shared';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { log } from '../common/logger.js';
import { PrismaService } from '../prisma/prisma.service.js';

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
 * request policy, banning) update the cache immediately, so no operation ever
 * observes its own stale write.
 */
export interface IdentityFacts {
  readonly userId: string;
  readonly publicId: string;
  readonly banned: boolean;
  readonly incomingRequests: IncomingRequestPolicy;
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
  patch(userId: string, patch: Partial<Pick<IdentityFacts, 'banned' | 'incomingRequests'>>): void {
    const current = this.facts.get(userId);
    if (!current) return;
    this.facts.set(userId, { ...current, ...patch });
  }

  private async load(userId: string): Promise<void> {
    const [identity, blockedByMe, blockingMe] = await Promise.all([
      this.prisma.identity.findUnique({
        where: { id: userId },
        select: { id: true, publicId: true, bannedAt: true, incomingRequests: true },
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
