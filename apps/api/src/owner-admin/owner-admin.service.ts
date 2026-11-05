import { Injectable } from '@nestjs/common';
import {
  ErrorCode,
  normalizePublicId,
  type AdminOwnerChatSummaryView,
  type AdminOwnerChatView,
  type AdminOwnerJoinResponse,
  type AdminOwnerReservationListResponse,
  type AdminOwnerReservationView,
  type AdminUserListResponse,
  type AdminUserQuery,
  type AdminUserView,
} from '@anonlink/shared';
import { Prisma } from '../generated/prisma/client.js';

import { AppError } from '../common/app-error.js';
import { ChatService } from '../chat/chat.service.js';
import type { StoredMedia } from '../chat/chat.media.js';
import type { ChatRecord } from '../chat/chat.registry.js';
import { DirectoryService } from '../directory/directory.service.js';
import {
  AdminIdentityRow,
  ADMIN_IDENTITY_SELECT,
  toAdminIdentityView,
} from '../moderation/admin-identity.js';
import {
  IDENTITY_SETTINGS_SELECT,
  toDeclaredProfile,
  toSearchPreferences,
  type IdentitySettingsRow,
} from '../identity/settings.mapper.js';
import { OwnerMatchService } from '../owner-match/owner-match.service.js';
import { PresenceService } from '../presence/presence.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DEFAULT_LIMIT = 50;
/** Status is in-memory; read a bounded page before filtering so a rare status is not missed. */
const STATUS_SCAN_LIMIT = 500;

const ADMIN_USER_SELECT = {
  id: true,
  ...ADMIN_IDENTITY_SELECT,
  ...IDENTITY_SETTINGS_SELECT,
  ownerFavorite: { select: { createdAt: true } },
} as const;

interface AdminUserRow extends AdminIdentityRow, IdentitySettingsRow {
  id: string;
  ownerFavorite: { createdAt: Date } | null;
}

interface ActivityFlags {
  online: boolean;
  searching: boolean;
  chatting: boolean;
  reserved: boolean;
  ownerChatId: string | null;
}

/**
 * The owner's directory and hidden conversations.
 *
 * ## Why search is bounded
 *
 * The owner asked to find people by any declared attribute or filter. That is a different
 * job from the public User-ID lookup, which is deliberately narrow. The server still
 * requires a criterion (or the favorites filter) and caps the result: an admin route is
 * not a reason to stream the whole identity table into a browser by accident.
 *
 * ## Why activity is filtered in memory
 *
 * `online`, `searching` and `chatting` are facts of this process, not columns. Pretending
 * they are SQL would either require an index that cannot exist or a confusing empty
 * answer. A bounded database page is filtered here instead, and the page size is chosen
 * so the documented result cap is still reached in normal use.
 */
@Injectable()
export class OwnerAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
    private readonly directory: DirectoryService,
    private readonly ownerMatch: OwnerMatchService,
    private readonly presence: PresenceService,
  ) {}

  async search(query: AdminUserQuery): Promise<AdminUserListResponse> {
    if (!this.hasCriterion(query)) return { users: [] };

    const where = this.buildWhere(query);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const take = query.status && query.status !== 'any' ? STATUS_SCAN_LIMIT : limit;

    const rows = await this.prisma.identity.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      select: ADMIN_USER_SELECT,
    });

    const reservations = new Set(
      (await this.ownerMatch.listReservations()).map((row) => row.targetId),
    );

    const users: AdminUserView[] = [];
    for (const row of rows) {
      const state = this.chat.stateFor(row.id);
      const flags: ActivityFlags = {
        online: this.presence.isOnline(row.id),
        searching: state.queued,
        chatting: state.activeChat !== undefined,
        reserved: reservations.has(row.id),
        ownerChatId: this.chat.ownerChatIdForTarget(row.id),
      };

      if (!this.matchesStatus(query.status, flags)) continue;
      users.push(this.toView(row, flags));
      if (users.length >= limit) break;
    }

    return { users };
  }

  async setFavorite(publicId: string, favorite: boolean): Promise<{ favorite: boolean }> {
    const target = await this.findTarget(publicId);

    if (favorite) {
      await this.prisma.ownerFavorite.upsert({
        where: { identityId: target.id },
        create: { identityId: target.id },
        update: {},
      });
    } else {
      await this.prisma.ownerFavorite.deleteMany({ where: { identityId: target.id } });
    }

    return { favorite };
  }

  async join(publicId: string): Promise<AdminOwnerJoinResponse> {
    const target = await this.findTarget(publicId);
    if (target.bannedAt !== null || this.directory.isBanned(target.id)) {
      throw new AppError(ErrorCode.IDENTITY_BANNED);
    }

    await this.directory.ensureLoaded(target.id);
    const result = await this.chat.joinAsOwner(target.id);
    if (result.kind === 'reserved') return { kind: 'reserved', chat: null };

    return {
      kind: 'joined',
      chat: this.summaryFor(result.chat, result.targetPublicId),
    };
  }

  listChats(): AdminOwnerChatSummaryView[] {
    return this.chat
      .ownerChatEntries()
      .map((entry) => {
        const chat = this.chat.ownerChat(entry.chatId)?.chat;
        return chat ? this.summaryFor(chat, entry.targetPublicId) : null;
      })
      .filter((summary): summary is AdminOwnerChatSummaryView => summary !== null);
  }

  readChat(chatId: string): AdminOwnerChatView {
    const found = this.chat.ownerChat(chatId);
    if (!found) throw new AppError(ErrorCode.CHAT_NOT_FOUND);

    return {
      chat: this.summaryFor(found.chat, found.entry.targetPublicId),
      messages: found.chat.messages.map((message) => ({
        messageId: message.messageId,
        from: message.senderId === found.entry.personaId ? 'owner' : 'target',
        text: message.text,
        media: message.media ?? null,
        sentAt: message.sentAt.toISOString(),
      })),
    };
  }

  readMedia(chatId: string, mediaId: string): StoredMedia {
    return this.chat.readOwnerMedia(chatId, mediaId);
  }

  sendMessage(chatId: string, text: string): { messageId: string; sentAt: string } {
    const sent = this.chat.sendOwnerMessage(chatId, text);
    return { messageId: sent.messageId, sentAt: sent.sentAt.toISOString() };
  }

  async leaveChat(chatId: string): Promise<void> {
    await this.chat.leaveOwnerChat(chatId);
  }

  async listReservations(): Promise<AdminOwnerReservationListResponse> {
    const rows = await this.ownerMatch.listReservations();
    const reservations: AdminOwnerReservationView[] = rows.map((row) => {
      const state = this.chat.stateFor(row.targetId);
      return {
        targetPublicId: row.targetPublicId,
        createdAt: row.createdAt.toISOString(),
        online: this.presence.isOnline(row.targetId),
        searching: state.queued,
        chatting: state.activeChat !== undefined,
      };
    });

    return { reservations };
  }

  async cancelReservation(publicId: string): Promise<{ cancelled: boolean }> {
    const target = await this.findTarget(publicId);
    return { cancelled: await this.ownerMatch.cancelReservation(target.id) };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async findTarget(publicId: string): Promise<{
    id: string;
    publicId: string;
    bannedAt: Date | null;
  }> {
    const target = await this.prisma.identity.findUnique({
      where: { publicId },
      select: { id: true, publicId: true, bannedAt: true, isOwnerPersona: true },
    });

    // A synthetic owner persona is not a person the owner can search for, star or join.
    if (!target || target.isOwnerPersona) throw new AppError(ErrorCode.USER_NOT_FOUND);
    return target;
  }

  private hasCriterion(query: AdminUserQuery): boolean {
    // Normalize before measuring: a query of four punctuation marks has no User-ID
    // fragment in it, and treating it as a criterion would turn the guard into an
    // accidental "return the newest people" request.
    const q = query.q ? normalizePublicId(query.q) : '';
    return (
      q.length >= 4 ||
      query.declaredGender !== undefined ||
      query.ageMin !== undefined ||
      query.ageMax !== undefined ||
      query.declaredCountry !== undefined ||
      query.declaredCity !== undefined ||
      query.declaredRegion !== undefined ||
      query.declaredLanguage !== undefined ||
      query.prefGender !== undefined ||
      query.seeksAge !== undefined ||
      query.prefCity !== undefined ||
      query.prefRegion !== undefined ||
      query.prefCountry !== undefined ||
      query.prefLanguage !== undefined ||
      query.prefRelax !== undefined ||
      query.favorite === 'yes' ||
      query.favorite === 'no' ||
      (query.status !== undefined && query.status !== 'any')
    );
  }

  private buildWhere(query: AdminUserQuery): Prisma.IdentityWhereInput {
    const and: Prisma.IdentityWhereInput[] = [];
    const q = query.q ? normalizePublicId(query.q) : '';
    if (q.length >= 4) and.push({ publicId: { startsWith: q } });

    if (query.declaredGender !== undefined) and.push({ declaredGender: query.declaredGender });
    if (query.declaredCountry !== undefined) and.push({ declaredCountry: query.declaredCountry });
    if (query.declaredCity !== undefined) {
      and.push({ declaredCity: { contains: query.declaredCity, mode: 'insensitive' } });
    }
    if (query.declaredRegion !== undefined) {
      and.push({ declaredRegion: { contains: query.declaredRegion, mode: 'insensitive' } });
    }
    if (query.declaredLanguage !== undefined) {
      and.push({ declaredLanguages: { has: query.declaredLanguage } });
    }

    if (query.prefGender !== undefined) and.push({ prefGenders: { has: query.prefGender } });
    if (query.prefCity !== undefined) and.push({ prefCities: { has: query.prefCity } });
    if (query.prefRegion !== undefined) and.push({ prefRegions: { has: query.prefRegion } });
    if (query.prefCountry !== undefined) and.push({ prefCountries: { has: query.prefCountry } });
    if (query.prefLanguage !== undefined) {
      and.push({ prefLanguages: { has: query.prefLanguage } });
    }
    if (query.prefRelax !== undefined) {
      and.push({ prefRelax: query.prefRelax === 'yes' });
    }

    if (query.seeksAge !== undefined) {
      and.push(
        // "Looking for age N" means N is inside a range the person actually set. A person
        // with no age bounds is not looking for any particular age.
        { OR: [{ prefAgeMin: { not: null } }, { prefAgeMax: { not: null } }] },
        { OR: [{ prefAgeMin: null }, { prefAgeMin: { lte: query.seeksAge } }] },
        { OR: [{ prefAgeMax: null }, { prefAgeMax: { gte: query.seeksAge } }] },
      );
    }

    const currentYear = new Date().getUTCFullYear();
    if (query.ageMin !== undefined || query.ageMax !== undefined) {
      and.push({
        declaredBirthYear: {
          ...(query.ageMin !== undefined ? { lte: currentYear - query.ageMin } : {}),
          ...(query.ageMax !== undefined ? { gte: currentYear - query.ageMax } : {}),
        },
      });
    }

    if (query.favorite === 'yes') and.push({ ownerFavorite: { isNot: null } });
    if (query.favorite === 'no') and.push({ ownerFavorite: { is: null } });

    return { AND: [{ isOwnerPersona: false }, ...and] };
  }

  private matchesStatus(
    status: AdminUserQuery['status'],
    flags: Pick<ActivityFlags, 'online' | 'searching' | 'chatting'>,
  ): boolean {
    switch (status) {
      case undefined:
      case 'any':
        return true;
      case 'online':
        return flags.online;
      case 'searching':
        return flags.searching;
      case 'chatting':
        return flags.chatting;
      case 'offline':
        return !flags.online && !flags.searching && !flags.chatting;
    }
  }

  private toView(row: AdminUserRow, flags: ActivityFlags): AdminUserView {
    return {
      ...toAdminIdentityView(row),
      incomingRequests: row.incomingRequests === 'nobody' ? 'nobody' : 'everyone',
      profile: toDeclaredProfile(row),
      search: toSearchPreferences(row),
      favorite: row.ownerFavorite !== null,
      favoriteSince: row.ownerFavorite?.createdAt.toISOString() ?? null,
      ...flags,
    };
  }

  private summaryFor(chat: ChatRecord, targetPublicId: string): AdminOwnerChatSummaryView {
    const last = chat.messages.at(-1);
    return {
      chatId: chat.chatId,
      targetPublicId,
      startedAt: chat.startedAt.toISOString(),
      endedAt: chat.endedAt?.toISOString() ?? null,
      endReason: chat.endReason,
      status: chat.isActive ? 'active' : 'ended',
      messageCount: chat.messageCount,
      lastMessageAt: last?.sentAt.toISOString() ?? null,
    };
  }
}
