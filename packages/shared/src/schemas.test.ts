import { describe, expect, it } from 'vitest';

import {
  blockSchema,
  chatMessageSchema,
  connectRequestSchema,
  connectRespondSchema,
  messageTextSchema,
  publicIdSchema,
  reportSchema,
  settingsSchema,
} from './schemas.js';

describe('publicIdSchema', () => {
  it('canonicalises friendly input', () => {
    expect(publicIdSchema.parse(' al7km3-9pq2-xrz4 ')).toBe('AL7KM39PQ2XRZ4');
  });

  it('accepts the common `A1` misreading of the fixed prefix', () => {
    expect(publicIdSchema.parse('a1 7km3 9pq2 xrz4')).toBe('AL7KM39PQ2XRZ4');
  });

  it('rejects malformed IDs', () => {
    expect(publicIdSchema.safeParse('AL1').success).toBe(false);
    expect(publicIdSchema.safeParse('AL7KM39PQ2XRZU').success).toBe(false);
  });
});

describe('messageTextSchema', () => {
  it('accepts a normal message', () => {
    expect(messageTextSchema.parse('hello there')).toBe('hello there');
  });

  it('rejects an empty message', () => {
    expect(messageTextSchema.safeParse('').success).toBe(false);
  });

  it('enforces the absolute upper bound', () => {
    expect(messageTextSchema.safeParse('x'.repeat(4001)).success).toBe(false);
    expect(messageTextSchema.safeParse('x'.repeat(4000)).success).toBe(true);
  });
});

describe('chatMessageSchema', () => {
  const chatId = '11111111-1111-4111-8111-111111111111';
  const valid = { chatId, clientMessageId: 'cm-1', text: 'hi' };

  it('accepts a well-formed payload', () => {
    expect(chatMessageSchema.parse(valid)).toEqual(valid);
  });

  it('rejects unknown extra properties (no hidden fields, no mass assignment)', () => {
    expect(chatMessageSchema.safeParse({ ...valid, senderId: 'spoofed' }).success).toBe(false);
  });

  it('rejects a non-UUID chat id', () => {
    expect(chatMessageSchema.safeParse({ ...valid, chatId: '../../etc/passwd' }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ ...valid, chatId: 'chat_12345678' }).success).toBe(false);
  });
});

describe('connectRequestSchema', () => {
  const publicId = 'AL7KM39PQ2XRZ4';

  it('accepts a request without a note', () => {
    expect(connectRequestSchema.parse({ publicId })).toEqual({ publicId });
  });

  it('rejects an over-long note', () => {
    expect(connectRequestSchema.safeParse({ publicId, note: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('connectRespondSchema', () => {
  it('requires an explicit accept/decline flag', () => {
    const requestId = '22222222-2222-4222-8222-222222222222';
    expect(connectRespondSchema.safeParse({ requestId }).success).toBe(false);
    expect(connectRespondSchema.safeParse({ requestId, accept: false }).success).toBe(true);
    expect(connectRespondSchema.safeParse({ requestId: 'not-a-uuid', accept: true }).success).toBe(
      false,
    );
  });
});

describe('reportSchema', () => {
  const chatId = '11111111-1111-4111-8111-111111111111';

  it('accepts a reason from the allow-list', () => {
    expect(reportSchema.safeParse({ chatId, reason: 'spam' }).success).toBe(true);
  });

  it('rejects an unknown reason', () => {
    expect(reportSchema.safeParse({ chatId, reason: 'because' }).success).toBe(false);
  });
});

describe('blockSchema / settingsSchema', () => {
  it('validates blocks', () => {
    expect(blockSchema.safeParse({ publicId: 'AL7KM39PQ2XRZ4' }).success).toBe(true);
  });

  it('validates settings and rejects unknown policies', () => {
    expect(settingsSchema.safeParse({ incomingRequests: 'nobody' }).success).toBe(true);
    expect(settingsSchema.safeParse({ incomingRequests: 'sometimes' }).success).toBe(false);
  });
});
