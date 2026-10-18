import { Injectable } from '@nestjs/common';

/**
 * Tracks which identities currently have at least one live socket.
 *
 * This lives outside the gateway because two very different components need it:
 * the gateway, to attach and detach sockets; and the chat service, to decide
 * whether a direct request can possibly be answered ("is this person here right
 * now?"). Keeping it in its own global module is what lets both use it without
 * the gateway and the chat service importing each other.
 *
 * The service deliberately stores only *counts of sockets per identity* — no
 * address, no user agent, nothing that would make it an identity store.
 */
@Injectable()
export class PresenceService {
  private readonly socketsByUser = new Map<string, Set<string>>();
  private readonly userBySocket = new Map<string, string>();

  /**
   * Attaches a socket.
   *
   * @returns `firstSocket: true` when this identity had no other socket, which is
   *   the moment to treat as "came online" (refresh cached facts, resume a chat).
   */
  register(socketId: string, userId: string): { sockets: number; firstSocket: boolean } {
    const previousUserId = this.userBySocket.get(socketId);
    if (previousUserId && previousUserId !== userId) this.detach(socketId);

    const sockets = this.socketsByUser.get(userId) ?? new Set<string>();
    const firstSocket = sockets.size === 0;
    sockets.add(socketId);
    this.socketsByUser.set(userId, sockets);
    this.userBySocket.set(socketId, userId);

    return { sockets: sockets.size, firstSocket };
  }

  /**
   * Detaches a socket.
   *
   * @returns `lastSocket: true` when the identity now has no sockets at all,
   *   i.e. the moment to start the reconnect grace period.
   */
  unregister(socketId: string): { userId?: string; lastSocket: boolean } {
    const userId = this.userBySocket.get(socketId);
    if (!userId) return { lastSocket: false };

    const remaining = this.detach(socketId);
    return { userId, lastSocket: remaining === 0 };
  }

  isOnline(userId: string): boolean {
    return (this.socketsByUser.get(userId)?.size ?? 0) > 0;
  }

  /**
   * Socket ids currently attached to an identity.
   *
   * Used to address a user without a broadcast: Socket.IO puts every socket in a
   * room named after its own id, so `server.to(socketId)` reaches exactly one
   * connection. That is what lets a message be rendered as `from: 'you'` for its
   * sender and `from: 'peer'` for everyone else.
   */
  socketIds(userId: string): string[] {
    return [...(this.socketsByUser.get(userId) ?? [])];
  }

  socketCount(userId: string): number {
    return this.socketsByUser.get(userId)?.size ?? 0;
  }

  /** Diagnostics: totals only, never a list of identities. */
  stats(): { onlineIdentities: number; sockets: number } {
    let sockets = 0;
    for (const set of this.socketsByUser.values()) sockets += set.size;
    return { onlineIdentities: this.socketsByUser.size, sockets };
  }

  private detach(socketId: string): number {
    const userId = this.userBySocket.get(socketId);
    if (!userId) return 0;

    this.userBySocket.delete(socketId);
    const sockets = this.socketsByUser.get(userId);
    if (!sockets) return 0;

    sockets.delete(socketId);
    if (sockets.size === 0) this.socketsByUser.delete(userId);
    return sockets.size;
  }
}
