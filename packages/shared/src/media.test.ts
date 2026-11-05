import { describe, expect, it } from 'vitest';

import {
  MEDIA_AUDIO_MAX_DURATION_MS,
  MEDIA_MAX_BYTES,
  MEDIA_VOICE_MAX_DURATION_MS,
  isAllowedMediaMime,
  mediaAcceptAttribute,
  mediaMaxDurationMs,
  normalizeMediaMimeType,
} from './media.js';
import { chatMessageSchema, mediaUploadQuerySchema } from './schemas.js';

const chatId = '11111111-1111-4111-8111-111111111111';
const mediaId = '22222222-2222-4222-8222-222222222222';

describe('normalizeMediaMimeType', () => {
  it('drops parameters and lower-cases the container', () => {
    expect(normalizeMediaMimeType('Audio/WebM; codecs=opus')).toBe('audio/webm');
    expect(normalizeMediaMimeType('IMAGE/JPEG')).toBe('image/jpeg');
  });

  it('maps the aliases real browsers and file managers produce', () => {
    expect(normalizeMediaMimeType('image/jpg')).toBe('image/jpeg');
    expect(normalizeMediaMimeType('audio/x-wav')).toBe('audio/wav');
    expect(normalizeMediaMimeType('audio/mp3')).toBe('audio/mpeg');
  });

  it('returns null for a missing or blank value', () => {
    expect(normalizeMediaMimeType(undefined)).toBeNull();
    expect(normalizeMediaMimeType('   ')).toBeNull();
  });
});

describe('media MIME policy', () => {
  it('accepts only known containers for each kind', () => {
    expect(isAllowedMediaMime('image', 'image/png')).toBe(true);
    expect(isAllowedMediaMime('image', 'image/svg+xml')).toBe(false);
    expect(isAllowedMediaMime('audio', 'audio/ogg')).toBe(true);
    expect(isAllowedMediaMime('voice', 'audio/webm')).toBe(true);
    expect(isAllowedMediaMime('voice', 'image/png')).toBe(false);
  });

  it('offers a picker filter that matches the accepted types', () => {
    expect(mediaAcceptAttribute('image')).toContain('image/png');
    expect(mediaAcceptAttribute('audio')).toContain('audio/ogg');
  });

  it('caps recordings but not still images', () => {
    expect(mediaMaxDurationMs('image')).toBeNull();
    expect(mediaMaxDurationMs('voice')).toBe(MEDIA_VOICE_MAX_DURATION_MS);
    expect(mediaMaxDurationMs('audio')).toBe(MEDIA_AUDIO_MAX_DURATION_MS);
    expect(MEDIA_MAX_BYTES.image).toBeLessThan(MEDIA_MAX_BYTES.audio);
  });
});

describe('chatMessageSchema with attachments', () => {
  it('accepts an attachment without a caption', () => {
    const parsed = chatMessageSchema.parse({ chatId, clientMessageId: 'cm-1', mediaId });
    expect(parsed.mediaId).toBe(mediaId);
    expect(parsed.text).toBeUndefined();
  });

  it('accepts text and an attachment together', () => {
    expect(
      chatMessageSchema.parse({ chatId, clientMessageId: 'cm-1', text: 'hi', mediaId }).mediaId,
    ).toBe(mediaId);
  });

  it('rejects a message with neither', () => {
    expect(chatMessageSchema.safeParse({ chatId, clientMessageId: 'cm-1' }).success).toBe(false);
  });

  it('rejects a non-UUID media id', () => {
    expect(
      chatMessageSchema.safeParse({ chatId, clientMessageId: 'cm-1', mediaId: 'not-a-uuid' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown field next to the attachment', () => {
    expect(
      chatMessageSchema.safeParse({ chatId, clientMessageId: 'cm-1', mediaId, senderId: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('mediaUploadQuerySchema', () => {
  it('accepts an image without a duration', () => {
    expect(mediaUploadQuerySchema.parse({ kind: 'image' })).toEqual({ kind: 'image' });
  });

  it('requires a duration for a voice message', () => {
    expect(mediaUploadQuerySchema.safeParse({ kind: 'voice' }).success).toBe(false);
    expect(mediaUploadQuerySchema.safeParse({ kind: 'voice', durationMs: 3_000 }).success).toBe(
      true,
    );
  });

  it('rejects a duration on an image', () => {
    expect(mediaUploadQuerySchema.safeParse({ kind: 'image', durationMs: 3_000 }).success).toBe(
      false,
    );
  });

  it('enforces the voice ceiling', () => {
    expect(
      mediaUploadQuerySchema.safeParse({
        kind: 'voice',
        durationMs: MEDIA_VOICE_MAX_DURATION_MS + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown kind and unknown fields', () => {
    expect(mediaUploadQuerySchema.safeParse({ kind: 'video' }).success).toBe(false);
    expect(mediaUploadQuerySchema.safeParse({ kind: 'image', filename: 'x.png' }).success).toBe(
      false,
    );
  });
});
