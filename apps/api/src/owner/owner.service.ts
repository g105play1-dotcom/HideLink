import { Inject, Injectable } from '@nestjs/common';
import type {
  OwnerMessageListResponse,
  OwnerMessageTopic,
  OwnerMessageView,
} from '@anonlink/shared';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { log } from '../common/logger.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The operator's inbox: messages users deliberately sent to the owner.
 *
 * ## Why this is a module of its own
 *
 * It stores user-written text, and that is rare enough here to deserve a named home rather
 * than a corner of the moderation service. Unlike a chat message it is *meant* to be read
 * by a human, so it is stored by design — but with the same discipline as everything else:
 * one retention deadline, enforced by the maintenance job, and browsable only on the
 * owner's surface. See docs/DECISIONS.md D26 and docs/SECURITY.md.
 *
 * The service knows nothing about chats, sockets or HTTP. Two other modules use it:
 * `ArchiveModule` renders the inbox inside the admin API, `MaintenanceModule` enforces its
 * retention — the same split the archive itself has.
 */

export interface CreateOwnerMessageInput {
  /** The sender, taken from the session by the controller, never from the request body. */
  identityId: string;
  topic: OwnerMessageTopic;
  text: string;
  contact?: string;
}

/** How many messages the inbox returns when the caller does not say. */
const DEFAULT_INBOX_LIMIT = 100;

@Injectable()
export class OwnerMessageService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Stores one message and tells the sender when it will be gone. */
  async create(input: CreateOwnerMessageInput): Promise<{ id: string; expiresAt: string }> {
    const expiresAt = new Date(Date.now() + this.config.OWNER_MESSAGE_RETENTION_DAYS * DAY_MS);

    const created = await this.prisma.ownerMessage.create({
      data: {
        identityId: input.identityId,
        topic: input.topic,
        text: input.text,
        contact: input.contact ?? null,
        expiresAt,
      },
      select: { id: true, expiresAt: true },
    });

    // The topic only — never the text, and never the contact line. An operator reading
    // the log should not be reading someone's message.
    log.info('owner.message_received', { topic: input.topic });

    return { id: created.id, expiresAt: created.expiresAt.toISOString() };
  }

  /** Newest first. The owner is a human with a screen, not a database client. */
  async list(limit: number = DEFAULT_INBOX_LIMIT): Promise<OwnerMessageListResponse> {
    const rows = await this.prisma.ownerMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        topic: true,
        text: true,
        contact: true,
        createdAt: true,
        expiresAt: true,
        identity: { select: { publicId: true } },
      },
    });

    const messages: OwnerMessageView[] = rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      text: row.text,
      contact: row.contact,
      publicId: row.identity?.publicId ?? null,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }));

    return { messages };
  }

  /** Deletes one message. There is no "read" flag: deleting is the only state change. */
  async delete(id: string): Promise<{ deleted: boolean }> {
    const result = await this.prisma.ownerMessage.deleteMany({ where: { id } });
    return { deleted: result.count > 0 };
  }

  /** Retention: everything past its deadline. Called by the maintenance sweep. */
  async deleteExpired(now: number = Date.now()): Promise<number> {
    const result = await this.prisma.ownerMessage.deleteMany({
      where: { expiresAt: { lt: new Date(now) } },
    });
    return result.count;
  }
}
