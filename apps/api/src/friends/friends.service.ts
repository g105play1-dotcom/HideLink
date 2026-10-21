import { Injectable } from '@nestjs/common';
import { FRIEND_LIST_LIMIT, ErrorCode, type FriendView } from '@anonlink/shared';

import { AppError } from '../common/app-error.js';
import { log } from '../common/logger.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * A friendship as the server knows it.
 *
 * Both public IDs are included because the same row is rendered differently for each
 * participant: each side must see the *other* person's ID, never their own.
 */
export interface FriendshipRecord {
  id: string;
  userIdA: string;
  userIdB: string;
  publicIdA: string;
  publicIdB: string;
  createdAt: Date;
}

export interface RemovedFriendship {
  removed: boolean;
  /** Present only when a row was actually deleted. */
  otherUserId?: string;
  otherPublicId?: string;
}

const FRIENDSHIP_SELECT = {
  id: true,
  userIdA: true,
  userIdB: true,
  createdAt: true,
  userA: { select: { publicId: true } },
  userB: { select: { publicId: true } },
} as const;

/**
 * Durable friendships.
 *
 * ## What this stores, and what it deliberately does not
 *
 * A row is exactly "these two identities agreed to be friends at this time". There is no
 * nickname, note, avatar, presence, last-seen time, shared chat id or message. The public
 * User IDs are read through the relations, so there is no second copy to drift or leak.
 *
 * ## Ordering
 *
 * The pair is canonical (`userIdA < userIdB`), which makes the unique index sufficient
 * to prevent duplicates regardless of who asked first. The database also has a check
 * constraint for the same rule; this service is the normal path, the constraint is the
 * backstop. See `prisma/migrations/20261020140000_add_friendships`.
 */
@Injectable()
export class FriendsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Whether the two identities are friends. Symmetric. */
  async areFriends(a: string, b: string): Promise<boolean> {
    if (a === b) return false;
    const pair = orderPair(a, b);
    const found = await this.prisma.friendship.findUnique({
      where: { userIdA_userIdB: pair },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * Creates the friendship if it does not exist and returns the row.
   *
   * Idempotent: accepting a request twice, or accepting after the other side did, must
   * not fail. It does not reveal whether the row was new to the caller.
   */
  async create(a: string, b: string): Promise<FriendshipRecord> {
    if (a === b) throw new AppError(ErrorCode.SELF_TARGET_NOT_ALLOWED);
    const pair = orderPair(a, b);

    const row = await this.prisma.friendship.upsert({
      where: { userIdA_userIdB: pair },
      create: pair,
      update: {},
      select: FRIENDSHIP_SELECT,
    });

    log.info('friend.created', {});
    return toRecord(row);
  }

  /** The caller's own friends, newest first, capped at {@link FRIEND_LIST_LIMIT}. */
  async list(userId: string): Promise<FriendView[]> {
    const rows = await this.prisma.friendship.findMany({
      where: { OR: [{ userIdA: userId }, { userIdB: userId }] },
      orderBy: { createdAt: 'desc' },
      take: FRIEND_LIST_LIMIT,
      select: FRIENDSHIP_SELECT,
    });

    return rows.map((row) => {
      const record = toRecord(row);
      return this.viewFor(record, userId);
    });
  }

  /**
   * Removes a friendship by the other person's public User ID.
   *
   * Returns `removed: false` for an unknown ID, a non-friend, and the caller's own ID
   * alike. That is deliberate: the endpoint must not become an oracle for "does this
   * person exist / are we friends" beyond the caller's own list.
   */
  async remove(userId: string, publicId: string): Promise<RemovedFriendship> {
    const other = await this.prisma.identity.findUnique({
      where: { publicId },
      select: { id: true, publicId: true },
    });
    if (!other || other.id === userId) return { removed: false };

    const pair = orderPair(userId, other.id);
    const deleted = await this.prisma.friendship.deleteMany({ where: pair });
    if (deleted.count === 0) return { removed: false };

    log.info('friend.removed', {});
    return { removed: true, otherUserId: other.id, otherPublicId: other.publicId };
  }

  /** The view of a friendship from one participant's side. */
  viewFor(record: FriendshipRecord, viewerId: string): FriendView {
    if (viewerId === record.userIdA) {
      return { publicId: record.publicIdB, since: record.createdAt.toISOString() };
    }
    if (viewerId === record.userIdB) {
      return { publicId: record.publicIdA, since: record.createdAt.toISOString() };
    }
    throw new AppError(ErrorCode.NOT_A_PARTICIPANT);
  }
}

function orderPair(a: string, b: string): { userIdA: string; userIdB: string } {
  return a < b ? { userIdA: a, userIdB: b } : { userIdA: b, userIdB: a };
}

interface FriendshipRow {
  id: string;
  userIdA: string;
  userIdB: string;
  createdAt: Date;
  userA: { publicId: string };
  userB: { publicId: string };
}

function toRecord(row: FriendshipRow): FriendshipRecord {
  return {
    id: row.id,
    userIdA: row.userIdA,
    userIdB: row.userIdB,
    publicIdA: row.userA.publicId,
    publicIdB: row.userB.publicId,
    createdAt: row.createdAt,
  };
}
