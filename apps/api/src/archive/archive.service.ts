import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DEFAULT_ARCHIVE_POLICY,
  ErrorCode,
  MEDIA_KINDS,
  archiveAudienceSchema,
  isGender,
  isLanguage,
  normalizePublicId,
  shouldArchiveChat,
  type AdminIdentityView,
  type ArchivePolicy,
  type ArchivedChatSummaryView,
  type ArchivedChatView,
  type ArchivedMessageView,
  type ChatKind,
  type MediaKind,
} from '@anonlink/shared';

import type { ChatRecord, StoredMessage } from '../chat/chat.registry.js';
import { AppError } from '../common/app-error.js';
import { log } from '../common/logger.js';
import { DirectoryService } from '../directory/directory.service.js';
import { ADMIN_IDENTITY_SELECT, toAdminIdentityView } from '../moderation/admin-identity.js';
import { PrismaService } from '../prisma/prisma.service.js';

const POLICY_ID = 'default';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
/** One transcript is capped so a single absurdly long chat cannot exhaust the owner's browser. */
const MAX_MESSAGES_PER_READ = 5000;

/**
 * The owner's archive: policy, storage and retrieval.
 *
 * ## What this is
 *
 * By default AnonLink stores no message text (see `docs/DECISIONS.md` D1). The owner
 * decided (D21) that transcripts *may* be kept, readable only by the owner, and that the
 * owner chooses by hand who, what and how long. This service is the only writer and the
 * only reader of `ChatArchive`/`ArchivedMessage`.
 *
 * ## Why the policy is cached
 *
 * `sendMessage` runs inside the chat domain and must not await a database read per
 * message. The policy is therefore loaded once at boot and refreshed on every write;
 * there is a single process, so the cache cannot disagree with the database for longer
 * than one request. Reading a *stale* policy can only under-record, never over-record:
 * `enabled: false` is the default and the fail-closed value.
 *
 * ## Why writes are chained per chat
 *
 * Storing a message means "upsert the archive, then insert the message". Two messages of
 * the same chat arriving back to back would otherwise race on the upsert and one would
 * fail on the unique `chatId`. Chaining the writes per chat keeps them ordered and
 * removes the race without a transaction that would block the chat pipeline.
 */
@Injectable()
export class ArchiveService implements OnModuleInit {
  private policy: ArchivePolicy = DEFAULT_ARCHIVE_POLICY;
  /** Per-chat write chains; see the class comment. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: DirectoryService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
    log.info('archive.policy_loaded', {
      enabled: this.policy.enabled,
      audience: this.policy.audience,
    });
  }

  /** The policy currently in force. Synchronous on purpose; see the class comment. */
  currentPolicy(): ArchivePolicy {
    return this.policy;
  }

  async reload(): Promise<void> {
    const row = await this.prisma.archivePolicy.findUnique({
      where: { id: POLICY_ID },
      include: { subjects: { include: { identity: { select: { publicId: true } } } } },
    });

    this.policy = row
      ? toPolicy(
          row,
          row.subjects.map((s) => s.identity.publicId),
        )
      : DEFAULT_ARCHIVE_POLICY;
  }

  // ---------------------------------------------------------------------------
  // Deciding what to store
  // ---------------------------------------------------------------------------

  /**
   * Whether a chat between `a` and `b` should be archived.
   *
   * Synchronous, because it is called from the matchmaker's critical section. Both
   * sides must be in the directory: an identity the server knows nothing about is
   * treated as "not in scope", so a cache miss can never cause extra recording.
   */
  shouldArchive(a: string, b: string, now: Date = new Date()): boolean {
    if (!this.policy.enabled) return false;

    const left = this.directory.get(a);
    const right = this.directory.get(b);
    if (!left || !right) return false;

    return shouldArchiveChat(
      this.policy,
      [
        { publicId: left.publicId, profile: left.profile },
        { publicId: right.publicId, profile: right.profile },
      ],
      now,
    );
  }

  /**
   * Stores one message of an archived chat.
   *
   * Fire-and-forget from the caller's point of view, but ordered per chat (see the class
   * comment). A message the policy does not cover (media-only today, or archiving just
   * switched off) is skipped entirely, which is why the text can be null.
   */
  recordMessage(chat: ChatRecord, message: StoredMessage): Promise<void> {
    const policy = this.policy;
    // Re-checked on every message, not only at chat start: switching the archive off must
    // stop recording immediately, not after the current conversation ends.
    if (!policy.enabled) return Promise.resolve();

    const text = policy.storeText ? message.text : null;
    // Attachments do not exist in the product yet, so `mediaKind` is always null for now;
    // the branch keeps "media only" honest instead of writing empty rows.
    const mediaKind: MediaKind | null = null;
    if (text === null && mediaKind === null) return Promise.resolve();

    const previous = this.chains.get(chat.chatId) ?? Promise.resolve();
    const next = previous
      .then(() => this.writeMessage(chat, message, text, mediaKind))
      .catch((error: unknown) => {
        log.error('archive.write_failed', error, { chatId: chat.chatId });
      });

    this.chains.set(chat.chatId, next);
    void next.finally(() => {
      if (this.chains.get(chat.chatId) === next) this.chains.delete(chat.chatId);
    });

    return next;
  }

  private async writeMessage(
    chat: ChatRecord,
    message: StoredMessage,
    text: string | null,
    mediaKind: MediaKind | null,
  ): Promise<void> {
    const expiresAt =
      this.policy.retentionDays > 0
        ? new Date(message.sentAt.getTime() + this.policy.retentionDays * DAY_MS)
        : null;

    const archive = await this.prisma.chatArchive.upsert({
      where: { chatId: chat.chatId },
      create: { chatId: chat.chatId, expiresAt, messageCount: 1 },
      update: { messageCount: { increment: 1 } },
      select: { id: true },
    });

    await this.prisma.archivedMessage.create({
      data: {
        archiveId: archive.id,
        senderId: message.senderId,
        text,
        mediaKind,
        sentAt: message.sentAt,
        // `messageCount` is incremented by `append` before this call, so it is the
        // message's 1-based position — and it keeps counting past the memory window.
        seq: chat.messageCount,
      },
    });
  }

  /** Awaits in-flight archive writes. Used by tests and graceful shutdown. */
  async flush(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.allSettled([...this.chains.values()]);
    }
  }

  // ---------------------------------------------------------------------------
  // Retention
  // ---------------------------------------------------------------------------

  /**
   * Deletes every archive whose retention deadline has passed.
   *
   * Called by the maintenance sweep, and exposed to the owner as "delete expired now" so
   * the same query is exercised by an integration test rather than trusted.
   */
  async deleteExpired(now: number = Date.now()): Promise<ArchiveDeletionCounts> {
    const expired = await this.prisma.chatArchive.findMany({
      where: { expiresAt: { lt: new Date(now) } },
      select: { id: true },
    });

    return this.deleteByIds(expired.map((row) => row.id));
  }

  /** Deletes the whole archive. The owner's manual purge. */
  async deleteAll(): Promise<ArchiveDeletionCounts> {
    const all = await this.prisma.chatArchive.findMany({ select: { id: true } });
    return this.deleteByIds(all.map((row) => row.id));
  }

  /** Deletes one archive. Returns `false` when there is nothing to delete. */
  async deleteChat(chatId: string): Promise<ArchiveDeletionCounts> {
    const found = await this.prisma.chatArchive.findUnique({
      where: { chatId },
      select: { id: true },
    });
    if (!found) return { deletedArchives: 0, deletedMessages: 0 };
    return this.deleteByIds([found.id]);
  }

  private async deleteByIds(ids: readonly string[]): Promise<ArchiveDeletionCounts> {
    if (ids.length === 0) return { deletedArchives: 0, deletedMessages: 0 };

    const where = { archiveId: { in: [...ids] } };
    const deletedMessages = await this.prisma.archivedMessage.count({ where });
    const deleted = await this.prisma.chatArchive.deleteMany({ where: { id: { in: [...ids] } } });

    return { deletedArchives: deleted.count, deletedMessages };
  }

  // ---------------------------------------------------------------------------
  // Owner reads
  // ---------------------------------------------------------------------------

  async list(limit: number = DEFAULT_LIST_LIMIT): Promise<ArchivedChatSummaryView[]> {
    const take = Math.min(Math.max(1, limit), MAX_LIST_LIMIT);
    const rows = await this.prisma.chatArchive.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      include: { chat: { select: CHAT_SUMMARY_SELECT } },
    });

    const publicIds = await this.publicIdsFor(
      rows.flatMap((row) => [row.chat.participantAId, row.chat.participantBId]),
    );

    return rows.map((row) => toSummary(row, publicIds));
  }

  async read(chatId: string): Promise<ArchivedChatView | null> {
    const row = await this.prisma.chatArchive.findUnique({
      where: { chatId },
      include: { chat: { select: CHAT_SUMMARY_SELECT } },
    });
    if (!row) return null;

    const [messages, publicIds] = await Promise.all([
      this.prisma.archivedMessage.findMany({
        where: { archiveId: row.id },
        orderBy: { seq: 'asc' },
        take: MAX_MESSAGES_PER_READ,
      }),
      this.publicIdsFor([row.chat.participantAId, row.chat.participantBId]),
    ]);

    const views: ArchivedMessageView[] = messages.map((message) => ({
      seq: message.seq,
      senderPublicId: publicIds.get(message.senderId) ?? UNKNOWN_USER,
      text: message.text,
      mediaKind: message.mediaKind,
      sentAt: message.sentAt.toISOString(),
    }));

    return { summary: toSummary(row, publicIds), messages: views };
  }

  /**
   * Finds identities by User ID or a prefix of one, so the owner can pick people.
   *
   * Prefix search is acceptable here precisely because the caller is the owner: the
   * anti-enumeration rule protects users from *each other*, and this endpoint is not
   * reachable without the owner's key.
   */
  async findIdentities(query: string, limit = 20): Promise<AdminIdentityView[]> {
    const normalized = normalizePublicId(query);
    if (!normalized.startsWith('AL') || normalized.length < 4) return [];

    const take = Math.min(Math.max(1, limit), 50);

    // The exact match is fetched separately. With a short prefix and many identities, the
    // owner could paste a complete User ID that sorts after the first page; a plain
    // `startsWith` query would then answer "not found" for a person who exists. The exact
    // row is also shown first, so the actionable person is not buried under prefix noise.
    const exact = await this.prisma.identity.findUnique({
      where: { publicId: normalized },
      select: ADMIN_IDENTITY_SELECT,
    });

    const rows =
      take > (exact ? 1 : 0)
        ? await this.prisma.identity.findMany({
            where: { publicId: { startsWith: normalized, not: normalized } },
            orderBy: { publicId: 'asc' },
            take: take - (exact ? 1 : 0),
            select: ADMIN_IDENTITY_SELECT,
          })
        : [];

    return (exact ? [exact, ...rows] : rows).map(toAdminIdentityView);
  }

  // ---------------------------------------------------------------------------
  // Owner writes
  // ---------------------------------------------------------------------------

  /**
   * Replaces the policy, and the selected-user list with it.
   *
   * The whole write is refused when a selected User ID does not exist: silently
   * dropping someone the owner meant to select would look like the archive working
   * while it was not recording that person at all.
   */
  async setPolicy(input: ArchivePolicy): Promise<ArchivePolicy> {
    const data = policyToColumns(input);

    if (input.selectedPublicIds.length > 0) {
      const rows = await this.prisma.identity.findMany({
        where: { publicId: { in: input.selectedPublicIds } },
        select: { id: true, publicId: true },
      });

      const known = new Set(rows.map((row) => row.publicId));
      const unknown = input.selectedPublicIds.filter((publicId) => !known.has(publicId));
      if (unknown.length > 0) {
        throw new AppError(ErrorCode.INVALID_INPUT, undefined, {
          context: `unknown User IDs: ${unknown.join(', ')}`,
        });
      }

      await this.prisma.$transaction([
        this.prisma.archivePolicy.upsert({
          where: { id: POLICY_ID },
          create: { id: POLICY_ID, ...data },
          update: data,
        }),
        this.prisma.archiveSubject.deleteMany({ where: { policyId: POLICY_ID } }),
        this.prisma.archiveSubject.createMany({
          data: rows.map((row) => ({ policyId: POLICY_ID, identityId: row.id })),
          skipDuplicates: true,
        }),
      ]);
    } else {
      await this.prisma.$transaction([
        this.prisma.archivePolicy.upsert({
          where: { id: POLICY_ID },
          create: { id: POLICY_ID, ...data },
          update: data,
        }),
        this.prisma.archiveSubject.deleteMany({ where: { policyId: POLICY_ID } }),
      ]);
    }

    await this.reload();

    // Counts only: the policy itself is a privacy decision and is worth an audit line,
    // but it contains no transcript and no user content.
    log.info('archive.policy_updated', {
      enabled: this.policy.enabled,
      audience: this.policy.audience,
      selected: this.policy.selectedPublicIds.length,
      retentionDays: this.policy.retentionDays,
    });

    return this.policy;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async publicIdsFor(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();

    const rows = await this.prisma.identity.findMany({
      where: { id: { in: unique } },
      select: { id: true, publicId: true },
    });

    return new Map(rows.map((row) => [row.id, row.publicId]));
  }
}

export interface ArchiveDeletionCounts {
  deletedArchives: number;
  deletedMessages: number;
}

const UNKNOWN_USER = '—';

const CHAT_SUMMARY_SELECT = {
  kind: true,
  startedAt: true,
  endedAt: true,
  endReason: true,
  messageCount: true,
  participantAId: true,
  participantBId: true,
} as const;

interface ArchiveRow {
  chatId: string;
  createdAt: Date;
  expiresAt: Date | null;
  messageCount: number;
  chat: {
    kind: string;
    startedAt: Date;
    endedAt: Date | null;
    endReason: string | null;
    messageCount: number;
    participantAId: string;
    participantBId: string;
  };
}

interface PolicyRow {
  enabled: boolean;
  audience: string;
  genders: readonly string[];
  ageMin: number | null;
  ageMax: number | null;
  cities: readonly string[];
  regions: readonly string[];
  languages: readonly string[];
  storeText: boolean;
  storeMedia: readonly string[];
  retentionDays: number;
}

function toSummary(row: ArchiveRow, publicIds: Map<string, string>): ArchivedChatSummaryView {
  return {
    chatId: row.chatId,
    kind: row.chat.kind as ChatKind,
    startedAt: row.chat.startedAt.toISOString(),
    endedAt: row.chat.endedAt?.toISOString() ?? null,
    endReason: row.chat.endReason,
    messageCount: row.chat.messageCount,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    participants: [
      { publicId: publicIds.get(row.chat.participantAId) ?? UNKNOWN_USER, role: 'a' },
      { publicId: publicIds.get(row.chat.participantBId) ?? UNKNOWN_USER, role: 'b' },
    ],
  };
}

/**
 * Columns -> policy.
 *
 * Read defensively, like `settings.mapper.ts`: an unknown value degrades to "store
 * nothing" rather than to "store everything", so a hand-edited row cannot widen the
 * archive by accident.
 */
function toPolicy(row: PolicyRow, selectedPublicIds: readonly string[]): ArchivePolicy {
  const audience = archiveAudienceSchema.safeParse(row.audience);

  return {
    enabled: row.enabled,
    audience: audience.success ? audience.data : 'criteria',
    criteria: {
      genders: row.genders.filter(isGender),
      ageMin: row.ageMin,
      ageMax: row.ageMax,
      cities: [...row.cities],
      regions: [...row.regions],
      languages: row.languages.filter(isLanguage),
    },
    selectedPublicIds: [...selectedPublicIds],
    storeText: row.storeText,
    storeMedia: row.storeMedia.filter(isMediaKind),
    retentionDays: row.retentionDays,
  };
}

/** Columns <- policy. Every column is written, so a cleared criterion is really cleared. */
function policyToColumns(input: ArchivePolicy): {
  enabled: boolean;
  audience: ArchivePolicy['audience'];
  genders: string[];
  ageMin: number | null;
  ageMax: number | null;
  cities: string[];
  regions: string[];
  languages: string[];
  storeText: boolean;
  storeMedia: string[];
  retentionDays: number;
} {
  return {
    enabled: input.enabled,
    audience: input.audience,
    genders: [...input.criteria.genders],
    ageMin: input.criteria.ageMin,
    ageMax: input.criteria.ageMax,
    cities: [...input.criteria.cities],
    regions: [...input.criteria.regions],
    languages: [...input.criteria.languages],
    storeText: input.storeText,
    storeMedia: [...input.storeMedia],
    retentionDays: input.retentionDays,
  };
}

function isMediaKind(value: string): value is MediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(value);
}
