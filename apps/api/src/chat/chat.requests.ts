import { Injectable } from '@nestjs/common';

/**
 * A pending "chat with me?" invitation, created when someone enters another
 * person's User ID.
 *
 * ## Why these are ephemeral
 *
 * A direct request only means something while the target is connected: accepting
 * it opens a live socket-to-socket chat. Persisting invitations would mean
 * inventing a notification system, a mailbox and a way to expire them, for a flow
 * with a 60-second useful lifetime. Keeping them in memory makes the expiry free
 * and leaves no trail of "who tried to contact whom" on disk, which is the
 * privacy-preserving default for this feature.
 *
 * The consequence is documented for operators: pending invitations do not survive
 * an API restart, and a target who reconnects does not see an invitation that was
 * sent while they were away. Both parties are told so explicitly by the protocol.
 */
export interface ConnectionRequest {
  readonly requestId: string;
  readonly fromUserId: string;
  readonly fromPublicId: string;
  readonly toUserId: string;
  readonly toPublicId: string;
  readonly note?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface CreateRequestInput {
  requestId: string;
  fromUserId: string;
  fromPublicId: string;
  toUserId: string;
  toPublicId: string;
  note?: string;
  ttlMs: number;
  /** Cap on simultaneously pending invitations *for the target*. */
  maxPending: number;
  now?: number;
}

export type CreateRequestOutcome =
  | { kind: 'created'; request: ConnectionRequest }
  /** The same sender already has a request pending for this target; reuse it. */
  | { kind: 'existing'; request: ConnectionRequest }
  | { kind: 'target_busy' };

@Injectable()
export class ConnectionRequestService {
  private readonly byId = new Map<string, ConnectionRequest>();
  /** `${fromUserId}:${toUserId}` -> requestId, for deduplication. */
  private readonly pairIndex = new Map<string, string>();
  /** toUserId -> requestIds currently pending for them. */
  private readonly pendingForTarget = new Map<string, Set<string>>();
  /** fromUserId -> requestIds this identity has sent. */
  private readonly pendingFromSender = new Map<string, Set<string>>();

  create(input: CreateRequestInput): CreateRequestOutcome {
    const now = input.now ?? Date.now();
    const pairKey = `${input.fromUserId}:${input.toUserId}`;

    const existingId = this.pairIndex.get(pairKey);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing && existing.expiresAt > now) return { kind: 'existing', request: existing };
      if (existing) this.remove(existingId);
    }

    const forTarget = this.pendingForTarget.get(input.toUserId);
    if (forTarget && forTarget.size >= input.maxPending) return { kind: 'target_busy' };

    const request: ConnectionRequest = {
      requestId: input.requestId,
      fromUserId: input.fromUserId,
      fromPublicId: input.fromPublicId,
      toUserId: input.toUserId,
      toPublicId: input.toPublicId,
      ...(input.note ? { note: input.note } : {}),
      createdAt: now,
      expiresAt: now + input.ttlMs,
    };

    this.byId.set(request.requestId, request);
    this.pairIndex.set(pairKey, request.requestId);
    this.addTo(this.pendingForTarget, input.toUserId, request.requestId);
    this.addTo(this.pendingFromSender, input.fromUserId, request.requestId);

    return { kind: 'created', request };
  }

  get(requestId: string): ConnectionRequest | undefined {
    return this.byId.get(requestId);
  }

  /** Number of invitations currently waiting for this identity's answer. */
  pendingCountFor(userId: string): number {
    return this.pendingForTarget.get(userId)?.size ?? 0;
  }

  isSender(userId: string, requestId: string): boolean {
    return this.byId.get(requestId)?.fromUserId === userId;
  }

  /**
   * Removes a request and returns it.
   *
   * Callers must use the returned record, because expiry is judged from it. A
   * `undefined` result means the request was already gone (answered, expired or
   * never existed), which is reported to clients as `REQUEST_NOT_FOUND` rather
   * than distinguished — an attacker should not be able to probe which ids exist.
   */
  take(requestId: string, now: number = Date.now()): ConnectionRequest | undefined {
    const request = this.byId.get(requestId);
    if (!request) return undefined;
    this.remove(requestId);
    void now;
    return request;
  }

  /** Removes and returns every request sent by an identity (e.g. it left). */
  takeBySender(userId: string): ConnectionRequest[] {
    const ids = [...(this.pendingFromSender.get(userId) ?? [])];
    return ids.map((id) => this.take(id)).filter((r): r is ConnectionRequest => Boolean(r));
  }

  /** Removes and returns every request addressed to an identity. */
  takeByTarget(userId: string): ConnectionRequest[] {
    const ids = [...(this.pendingForTarget.get(userId) ?? [])];
    return ids.map((id) => this.take(id)).filter((r): r is ConnectionRequest => Boolean(r));
  }

  /** Removes and returns all requests that have passed their deadline. */
  sweep(now: number = Date.now()): ConnectionRequest[] {
    const expired: ConnectionRequest[] = [];
    for (const request of [...this.byId.values()]) {
      if (request.expiresAt > now) continue;
      this.remove(request.requestId);
      expired.push(request);
    }
    return expired;
  }

  /**
   * Removes every request that links these two identities in either direction.
   *
   * Called when a chat between them ends or one of them blocks the other, so a
   * stale invitation cannot resurrect an interaction the user has just left.
   */
  takeBetween(a: string, b: string): ConnectionRequest[] {
    const results: ConnectionRequest[] = [];
    for (const request of [...this.byId.values()]) {
      const links =
        (request.fromUserId === a && request.toUserId === b) ||
        (request.fromUserId === b && request.toUserId === a);
      if (!links) continue;
      this.remove(request.requestId);
      results.push(request);
    }
    return results;
  }

  private remove(requestId: string): void {
    const request = this.byId.get(requestId);
    if (!request) return;

    this.byId.delete(requestId);
    this.pairIndex.delete(`${request.fromUserId}:${request.toUserId}`);
    this.deleteFrom(this.pendingForTarget, request.toUserId, requestId);
    this.deleteFrom(this.pendingFromSender, request.fromUserId, requestId);
  }

  private addTo(index: Map<string, Set<string>>, key: string, value: string): void {
    const set = index.get(key) ?? new Set<string>();
    set.add(value);
    index.set(key, set);
  }

  private deleteFrom(index: Map<string, Set<string>>, key: string, value: string): void {
    const set = index.get(key);
    if (!set) return;
    set.delete(value);
    if (set.size === 0) index.delete(key);
  }

  /** Diagnostics only. */
  stats(): { pending: number; targets: number } {
    return { pending: this.byId.size, targets: this.pendingForTarget.size };
  }
}
