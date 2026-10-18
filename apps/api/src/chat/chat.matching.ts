import { Injectable } from '@nestjs/common';
import { MATCH_TICKET_TTL_MS } from '@anonlink/shared';

interface Ticket {
  enqueuedAt: number;
}

/**
 * The random-matchmaking queue.
 *
 * ## Why an in-memory queue and not Redis
 *
 * The queue is the one piece of state that genuinely must be linearisable. Running
 * it inside the single process that owns the sockets makes every operation atomic
 * by construction (see the note in `ChatRegistryService`), with no external service
 * to operate, secure or back up — a real benefit for a project whose owner is not a
 * system administrator.
 *
 * The trade-off is explicit: **this design runs one API instance.** To scale out,
 * replace this class with a Redis/Valkey-backed implementation of the same methods
 * (`enqueue`, `cancel`, `claimOrEnqueue`, `sweep`) using Lua scripts or `WATCH`/
 * `MULTI` for the claim step. Nothing outside this file assumes in-memory storage.
 * See docs/DECISIONS.md.
 *
 * ## FIFO fairness
 *
 * `Map` preserves insertion order, so scanning tickets in iteration order yields
 * the longest-waiting eligible peer first — the intuitive and fair behaviour.
 */
@Injectable()
export class MatchingService {
  private readonly tickets = new Map<string, Ticket>();

  isQueued(userId: string): boolean {
    return this.tickets.has(userId);
  }

  /** When this identity started waiting, or `undefined` when it is not queued. */
  queuedSince(userId: string): Date | undefined {
    const ticket = this.tickets.get(userId);
    return ticket ? new Date(ticket.enqueuedAt) : undefined;
  }

  /**
   * Adds an identity to the queue.
   *
   * Idempotent: re-joining keeps the original position, so a duplicate
   * `match:join` (double click, reconnect) cannot reset a user's wait time or
   * create a second ticket.
   */
  enqueue(userId: string, now: number = Date.now()): Date {
    const existing = this.tickets.get(userId);
    if (existing) return new Date(existing.enqueuedAt);

    this.tickets.set(userId, { enqueuedAt: now });
    return new Date(now);
  }

  cancel(userId: string): boolean {
    return this.tickets.delete(userId);
  }

  /**
   * The single atomic matchmaking step.
   *
   * Either claims the longest-waiting eligible peer (removing it from the queue)
   * or enqueues the caller — never both, never neither. `isEligible` must be
   * synchronous and side-effect free; it is called once per waiting ticket and is
   * where block checks are applied.
   *
   * Because the caller is *not* yet in the queue when scanning, a peer can never
   * be matched with itself.
   */
  claimOrEnqueue(
    userId: string,
    isEligible: (candidateId: string) => boolean,
    now: number = Date.now(),
  ): { kind: 'matched'; peerId: string; peerWaitedSince: Date } | { kind: 'waiting'; since: Date } {
    for (const [candidateId, ticket] of this.tickets) {
      if (candidateId === userId) continue;
      if (!isEligible(candidateId)) continue;

      // Claim the peer. Both removals happen before returning, with no `await`
      // in between, so no other event can observe a half-updated queue.
      this.tickets.delete(candidateId);
      this.tickets.delete(userId);

      return { kind: 'matched', peerId: candidateId, peerWaitedSince: new Date(ticket.enqueuedAt) };
    }

    return { kind: 'waiting', since: this.enqueue(userId, now) };
  }

  /**
   * Drops tickets whose owner has gone quiet.
   *
   * A socket that dies without a clean close would otherwise sit in the queue and
   * be handed out as a peer that never answers.
   */
  sweep(now: number = Date.now()): string[] {
    const expired: string[] = [];
    for (const [userId, ticket] of this.tickets) {
      if (now - ticket.enqueuedAt > MATCH_TICKET_TTL_MS) {
        this.tickets.delete(userId);
        expired.push(userId);
      }
    }
    return expired;
  }

  /** Snapshot of the current waiters, oldest first. Diagnostics and tests only. */
  waitingUserIds(): string[] {
    return [...this.tickets.keys()];
  }

  depth(): number {
    return this.tickets.size;
  }
}
