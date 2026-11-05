import { z } from 'zod';

/**
 * Chat attachments: kinds, limits and MIME rules shared by the browser and the API.
 *
 * Media is deliberately *not* a second storage system. A photo or a voice message lives in
 * the API process exactly as long as the chat transcript does (see docs/SECURITY.md): it is
 * uploaded before the message is sent, kept only in memory, and dropped with the chat
 * tombstone. There is no public URL, no disk file and no database row containing the bytes.
 *
 * The browser validates against these same constants so a user gets immediate feedback,
 * while the server re-validates everything because a browser check is decoration.
 */

/** The attachment kinds the chat currently offers. Video and arbitrary files are out of scope. */
export const CHAT_MEDIA_KINDS = ['image', 'audio', 'voice'] as const;
export type ChatMediaKind = (typeof CHAT_MEDIA_KINDS)[number];

export const chatMediaKindSchema = z.enum(CHAT_MEDIA_KINDS);

/**
 * Canonical MIME types the API will accept.
 *
 * SVG is intentionally absent: an `<img>` will not execute its script, but the same bytes
 * served to another client, opened directly or embedded by a future feature, are an XSS
 * primitive. GIF is allowed because it is a normal image format; animated GIFs are not
 * re-encoded by the browser.
 */
export const MEDIA_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export const MEDIA_AUDIO_MIME_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/aac',
] as const;

/** Per-kind upload ceilings. The browser compresses photos before they reach this limit. */
export const MEDIA_MAX_BYTES: Record<ChatMediaKind, number> = {
  image: 8 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  voice: 8 * 1024 * 1024,
};

/** A voice recording is a short spoken message, not a podcast. */
export const MEDIA_VOICE_MAX_DURATION_MS = 120_000;

/** Audio files may be longer, but the metadata is still bounded. */
export const MEDIA_AUDIO_MAX_DURATION_MS = 600_000;

/**
 * How much media one conversation may hold at once.
 *
 * A chat can contain at most 200 text messages in the registry, but those are tiny. Media
 * needs a separate budget: one chat is capped at 32 MB and the whole process at 128 MB, so
 * a single conversation cannot exhaust the API. An upload that would cross either limit is
 * refused rather than silently evicting an earlier photo the user can still see.
 */
export const MEDIA_MAX_ITEMS_PER_CHAT = 32;
export const MEDIA_MAX_BYTES_PER_CHAT = 32 * 1024 * 1024;
export const MEDIA_MAX_BYTES_TOTAL = 128 * 1024 * 1024;

/**
 * An uploaded file that never became a message is deleted after this long.
 *
 * Upload-then-send is two requests; a client that uploads and disconnects must not leave
 * bytes in memory forever. Ten minutes is long enough for a slow mobile upload followed by
 * a retry, and short enough that abandoned files are not a leak.
 */
export const MEDIA_UNATTACHED_TTL_MS = 10 * 60 * 1000;

/** The wire shape of an attachment. It contains no URL and no uploader identity. */
export interface ChatMediaView {
  mediaId: string;
  kind: ChatMediaKind;
  mimeType: string;
  /** Exact byte length. The client uses it for a placeholder, never for trust. */
  size: number;
  /** Present for audio and voice; milliseconds. */
  durationMs?: number;
}

/** MIME aliases produced by real browsers and file managers. */
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/ogg; codecs=opus': 'audio/ogg',
};

/**
 * Normalises a `Content-Type` value to a canonical MIME type.
 *
 * Returns `null` for an empty value. Parameters such as `;codecs=opus` are dropped: they
 * describe the codec, not the container, and the magic-byte check is the authority on what
 * the file actually is.
 */
export function normalizeMediaMimeType(value: string | undefined | null): string | null {
  if (!value) return null;
  const base = value.split(';')[0]?.trim().toLowerCase();
  if (!base) return null;
  return MIME_ALIASES[base] ?? base;
}

/** Whether a canonical MIME type is acceptable for this attachment kind. */
export function isAllowedMediaMime(kind: ChatMediaKind, mimeType: string): boolean {
  switch (kind) {
    case 'image':
      return (MEDIA_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
    case 'audio':
    case 'voice':
      return (MEDIA_AUDIO_MIME_TYPES as readonly string[]).includes(mimeType);
    default:
      return false;
  }
}

/** The accepted MIME list for a file picker. Voice is recorded, not picked. */
export function mediaAcceptAttribute(kind: 'image' | 'audio'): string {
  return (kind === 'image' ? MEDIA_IMAGE_MIME_TYPES : MEDIA_AUDIO_MIME_TYPES).join(',');
}

/** Duration cap for a kind, or `null` when the server does not enforce one. */
export function mediaMaxDurationMs(kind: ChatMediaKind): number | null {
  if (kind === 'voice') return MEDIA_VOICE_MAX_DURATION_MS;
  if (kind === 'audio') return MEDIA_AUDIO_MAX_DURATION_MS;
  return null;
}
