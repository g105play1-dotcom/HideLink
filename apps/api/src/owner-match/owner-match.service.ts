import { Injectable } from '@nestjs/common';
import {
  ErrorCode,
  generatePublicId,
  profileSatisfyingPreferences,
  type SearchPreferences,
} from '@anonlink/shared';

import { AppError } from '../common/app-error.js';
import { log } from '../common/logger.js';
import { DirectoryService } from '../directory/directory.service.js';
import { isUniqueViolation } from '../identity/identity.service.js';
import { profileToColumns } from '../identity/settings.mapper.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface OwnerPersona {
  identityId: string;
  publicId: string;
}

export interface OwnerReservationRow {
  targetId: string;
  targetPublicId: string;
  createdAt: Date;
}

/**
 * The owner's hidden identity and next-search reservations (D39).
 *
 * Kept apart from the admin HTTP surface so the chat domain can consume a reservation
 * without importing a controller module — and, more importantly, without the dependency
 * pointing from chat to an admin module. This service knows nothing about sockets, chats
 * or REST; it only writes the two small tables and builds the synthetic identity.
 *
 * ## Why a fresh persona per chat
 *
 * A persona is an ordinary-looking identity with no session. Reusing one per target would
 * let a block, a report or a User ID disclosed by the block list accumulate against the
 * owner's hidden identity and affect later conversations. A new random identity per chat
 * keeps the random-chat promise — nothing links two conversations — and leaves no stable
 * handle for a user to target. The rows are inert and carry no messages.
 */
@Injectable()
export class OwnerMatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: DirectoryService,
  ) {}

  /**
   * Creates the peer that will stand in front of one target.
   *
   * Its declaration mirrors the target's active filters rather than bypassing them: a
   * user who asked for women aged 25–35 in Kazan gets exactly that declaration, so the
   * normal mutual-filter rule still holds. The persona gets no search preferences of its
   * own, so it accepts anybody; it will never be matched normally because it is never
   * queued and has no socket.
   */
  async createPersona(preferences: SearchPreferences): Promise<OwnerPersona> {
    const profile = profileSatisfyingPreferences(preferences);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const publicId = generatePublicId();
      try {
        const created = await this.prisma.identity.create({
          data: {
            publicId,
            isOwnerPersona: true,
            incomingRequests: 'nobody',
            ...profileToColumns({ ...profile, languages: [...profile.languages] }),
          },
          select: { id: true, publicId: true },
        });

        // The archive and the matchmaker read facts from the directory; a persona that is
        // not loaded would fail closed in `shouldArchive` and `sides`, so load it now. If
        // loading fails, remove the row: the caller never receives its id and could not
        // clean it up, and an unreachable synthetic identity has no purpose.
        try {
          await this.directory.refresh(created.id);
        } catch (error) {
          await this.prisma.identity
            .deleteMany({ where: { id: created.id, isOwnerPersona: true } })
            .catch((deleteError: unknown) => {
              log.error('owner.persona_discard_failed', deleteError);
            });
          throw error;
        }
        log.info('owner.persona_created', { attempt });
        return { identityId: created.id, publicId: created.publicId };
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }
    }

    throw new AppError(ErrorCode.INTERNAL_ERROR, 'Could not allocate a hidden peer.');
  }

  /**
   * Removes a persona that never reached a chat.
   *
   * A persona is inert, but leaving one behind after a failed join would slowly fill the
   * identity table with synthetic rows that no surface can show or delete. The chat path
   * calls this only after it has decided not to use the persona; a persona inside a chat is
   * never discarded.
   */
  async discardPersona(identityId: string): Promise<void> {
    await this.prisma.identity.deleteMany({
      where: { id: identityId, isOwnerPersona: true },
    });
    this.directory.forget(identityId);
  }

  /**
   * Arms "the owner is first on this person's next search".
   *
   * Idempotent: pressing the button twice keeps one reservation rather than a queue of
   * owners. The original timestamp is kept so the panel can show how long it has waited.
   */
  async reserve(targetId: string): Promise<void> {
    await this.prisma.ownerReservation.upsert({
      where: { targetId },
      create: { targetId },
      update: {},
    });
  }

  /**
   * Claims the reservation exactly once.
   *
   * `deleteMany` is the atomic claim: two concurrent `match:join` calls cannot both see a
   * row and both create a chat. The caller re-arms it if the subsequent chat creation
   * fails.
   */
  async takeReservation(targetId: string): Promise<boolean> {
    const result = await this.prisma.ownerReservation.deleteMany({ where: { targetId } });
    return result.count > 0;
  }

  async cancelReservation(targetId: string): Promise<boolean> {
    const result = await this.prisma.ownerReservation.deleteMany({ where: { targetId } });
    return result.count > 0;
  }

  async listReservations(): Promise<OwnerReservationRow[]> {
    const rows = await this.prisma.ownerReservation.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        targetId: true,
        createdAt: true,
        target: { select: { publicId: true } },
      },
    });

    return rows.map((row) => ({
      targetId: row.targetId,
      targetPublicId: row.target.publicId,
      createdAt: row.createdAt,
    }));
  }
}
