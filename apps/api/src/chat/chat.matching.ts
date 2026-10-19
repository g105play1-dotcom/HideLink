import { Injectable } from '@nestjs/common';
import { MATCH_TICKET_TTL_MS, relaxationStage } from '@anonlink/shared';

interface Ticket {
  enqueuedAt: number;
  /** Whether the owner allowed the search to be widened after a long wait. */
  relaxAllowed: boolean;
  /**
   * How many relaxation steps have already been applied to this ticket.
   *
   * Kept on the ticket rather than recomputed from the clock so a step is applied exactly
   * once, no matter how many sweeps run while the user waits.
   */
  relaxedSteps: number;
}

/**
 * What an eligibility check may know about a waiting ticket.
 *
 * Deliberately read-only and minimal: the matchmaker needs the wait time (for fairness)
 * and the number of relaxation steps taken (because a widened search accepts more
 * people), and nothing else.
 */
export interface TicketView {
  readonly enqueuedAt: number;
  readonly relaxedSteps: number;
}

/** A ticket that has waited long enough for the next relaxation step. */
export interface RelaxationDue {
  readonly userId: string;
  /** Steps applied before this sweep. */
  readonly previousSteps: number;
  /** Steps in force now, as allowed by the wait time. */
  readonly steps: number;
}

export interface EnqueueOptions {
  now?: number;
  relaxAllowed?: boolean;
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
 * (`enqueue`, `cancel`, `claimOrEnqueue`, `relaxationDue`, `sweep`) using Lua scripts or
 * `WATCH`/`MULTI` for the claim step. Nothing outside this file assumes in-memory storage.
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

  /** The current relaxation stage of a waiting ticket; `0` when not queued. */
  relaxedStepsOf(userId: string): number {
    return this.tickets.get(userId)?.relaxedSteps ?? 0;
  }

  /**
   * Adds an identity to the queue.
   *
   * Idempotent: re-joining keeps the original position, so a duplicate
   * `match:join` (double click, reconnect) cannot reset a user's wait time or
   * create a second ticket.
   */
  enqueue(userId: string, options: EnqueueOptions = {}): Date {
    const existing = this.tickets.get(userId);
    if (existing) {
      // A re-join may carry a fresh answer to "may we widen the search?", so the
      // permission is updated while the queue position is kept. Nothing else changes.
      if (options.relaxAllowed !== undefined) existing.relaxAllowed = options.relaxAllowed;
      return new Date(existing.enqueuedAt);
    }

    const now = options.now ?? Date.now();
    this.tickets.set(userId, {
      enqueuedAt: now,
      relaxAllowed: options.relaxAllowed ?? false,
      relaxedSteps: 0,
    });
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
   * where block, ban and filter checks are applied.
   *
   * Because the caller is *not* yet in the queue when scanning, a peer can never
   * be matched with itself.
   */
  claimOrEnqueue(
    userId: string,
    isEligible: (candidateId: string, candidate: TicketView) => boolean,
    options: EnqueueOptions = {},
  ): { kind: 'matched'; peerId: string; peerWaitedSince: Date } | { kind: 'waiting'; since: Date } {
    for (const [candidateId, ticket] of this.tickets) {
      if (candidateId === userId) continue;
      if (
        !isEligible(candidateId, {
          enqueuedAt: ticket.enqueuedAt,
          relaxedSteps: ticket.relaxedSteps,
        })
      ) {
        continue;
      }

      // Claim the peer. Both removals happen before returning, with no `await`
      // in between, so no other event can observe a half-updated queue.
      this.tickets.delete(candidateId);
      this.tickets.delete(userId);

      return { kind: 'matched', peerId: candidateId, peerWaitedSince: new Date(ticket.enqueuedAt) };
    }

    return { kind: 'waiting', since: this.enqueue(userId, options) };
  }

  /**
   * Reports every ticket that has waited long enough for another relaxation step.
   *
   * The queue only tracks *time*: which filter a step removes, whether anything was left
   * to remove and what to tell the user all stay in the chat service, so this class holds
   * no knowledge of the filter vocabulary. `relaxAfterMs <= 0` disables relaxation
   * entirely, which is how the integration tests keep filters deterministic.
   */
  relaxationDue(now: number, options: { relaxAfterMs: number; stepMs: number }): RelaxationDue[] {
    if (options.relaxAfterMs <= 0) return [];

    const due: RelaxationDue[] = [];
    for (const [userId, ticket] of this.tickets) {
      if (!ticket.relaxAllowed) continue;

      const steps = relaxationStage(now - ticket.enqueuedAt, options);
      if (steps <= ticket.relaxedSteps) continue;

      const previousSteps = ticket.relaxedSteps;
      ticket.relaxedSteps = steps;
      due.push({ userId, previousSteps, steps });
    }

    return due;
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
