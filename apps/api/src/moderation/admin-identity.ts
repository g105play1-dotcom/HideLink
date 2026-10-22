import type { AdminIdentityView } from '@anonlink/shared';

/**
 * The fields the owner's identity search may read.
 *
 * Defined once because two services need the same shape: `ArchiveService` finds people
 * for the archive's selected-audience list, and `ModerationService` finds the same people
 * to ban or unban. If one of them forgot `bannedAt`, the owner would see an "active"
 * account in one panel and a suspended one in the other.
 */
export const ADMIN_IDENTITY_SELECT = {
  publicId: true,
  createdAt: true,
  bannedAt: true,
  bannedReason: true,
} as const;

export interface AdminIdentityRow {
  publicId: string;
  createdAt: Date;
  bannedAt: Date | null;
  bannedReason: string | null;
}

export function toAdminIdentityView(row: AdminIdentityRow): AdminIdentityView {
  return {
    publicId: row.publicId,
    createdAt: row.createdAt.toISOString(),
    banned: row.bannedAt !== null,
    bannedAt: row.bannedAt?.toISOString() ?? null,
    bannedReason: row.bannedReason,
  };
}
