import { ErrorCode } from '@anonlink/shared';
import type { ChatMessageView, ErrorPayload } from '@anonlink/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  RealtimeClient,
  createIdentity,
  downloadMedia,
  http,
  joinQueue,
  matchPair,
  sendMediaMessage,
  uploadMedia,
} from './support/api-client.js';

/**
 * Attachments, against a real server.
 *
 * The interesting properties are not "bytes go in, bytes come out": they are
 * authorisation and lifetime. An attachment belongs to one chat and one uploader, its id
 * grants nothing on its own, and its bytes are not addressable without the session cookie.
 * Those are exactly the rules a browser-side check cannot enforce, so they are tested here.
 */

const open: RealtimeClient[] = [];

afterEach(async () => {
  for (const client of open.splice(0)) {
    const started = client.eventsNamed('chat:started').at(-1) as
      { chat?: { chatId?: string } } | undefined;
    const chatId = started?.chat?.chatId;

    if (chatId) await client.emit('chat:leave', { chatId });
    await client.emit('match:cancel');
    client.close();
  }
});

afterAll(() => {
  for (const client of open.splice(0)) client.close();
});

/** Minimal files: only the magic bytes the server sniffs. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png-payload'),
]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('webm-payload')]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

async function participant(): Promise<RealtimeClient> {
  const client = await RealtimeClient.connect(await createIdentity());
  open.push(client);
  return client;
}

/** Waits for the message carrying one specific upload, not just any attachment. */
function messageWithMedia(client: RealtimeClient, mediaId: string): Promise<ChatMessageView> {
  return client.waitFor<ChatMessageView>('chat:message', {
    predicate: (payload) => (payload as ChatMessageView).media?.mediaId === mediaId,
  });
}

/**
 * Matches two already-connected clients into a *new* chat.
 *
 * `matchPair` scans from the start of each buffer, so a second call in the same test would
 * immediately resolve with the first `chat:started` event. Only new events count here.
 */
async function matchAgain(a: RealtimeClient, b: RealtimeClient): Promise<{ chatId: string }> {
  const aStarted = a.waitFor<{ chat: { chatId: string } }>('chat:started', {
    fromIndex: a.received.length,
  });
  const bStarted = b.waitFor<{ chat: { chatId: string } }>('chat:started', {
    fromIndex: b.received.length,
  });

  const aJoin = await joinQueue(a);
  if (!aJoin.ok) throw new Error(`match:join (a) failed: ${JSON.stringify(aJoin.error)}`);
  const bJoin = await joinQueue(b);
  if (!bJoin.ok) throw new Error(`match:join (b) failed: ${JSON.stringify(bJoin.error)}`);

  const [fromA, fromB] = await Promise.all([aStarted, bStarted]);
  expect(fromA.chat.chatId).toBe(fromB.chat.chatId);
  return { chatId: fromA.chat.chatId };
}

describe('chat attachments', () => {
  it('uploads, publishes and serves a photo to both participants', async () => {
    const a = await participant();
    const b = await participant();
    const { chatId } = await matchPair(a, b);

    const upload = await uploadMedia(a.identity, chatId, 'image', PNG);
    expect(upload.status).toBe(200);
    expect(upload.body.kind).toBe('image');
    expect(upload.body.mimeType).toBe('image/png');
    expect(upload.body.size).toBe(PNG.length);

    const bReceived = messageWithMedia(b, upload.body.mediaId);
    const aReceived = messageWithMedia(a, upload.body.mediaId);
    const sent = await sendMediaMessage(a, chatId, upload.body.mediaId);
    expect(sent.ok).toBe(true);

    const [toB, toA] = await Promise.all([bReceived, aReceived]);
    expect(toB.from).toBe('peer');
    expect(toA.from).toBe('you');
    expect(toB.text).toBe('');
    expect(toB.media?.mediaId).toBe(upload.body.mediaId);

    const downloaded = await downloadMedia(b.identity, chatId, upload.body.mediaId);
    expect(downloaded.status).toBe(200);
    expect(downloaded.contentType).toContain('image/png');
    expect(downloaded.bytes.equals(PNG)).toBe(true);
  });

  it('accepts a caption and a voice message with its duration', async () => {
    const a = await participant();
    const b = await participant();
    const { chatId } = await matchPair(a, b);

    const photo = await uploadMedia(a.identity, chatId, 'image', PNG);
    const bPhoto = messageWithMedia(b, photo.body.mediaId);
    await sendMediaMessage(a, chatId, photo.body.mediaId, { text: 'look at this' });
    const withCaption = await bPhoto;
    expect(withCaption.text).toBe('look at this');

    const voice = await uploadMedia(a.identity, chatId, 'voice', WEBM, { durationMs: 4_200 });
    expect(voice.status).toBe(200);
    expect(voice.body.durationMs).toBe(4_200);

    const bVoice = messageWithMedia(b, voice.body.mediaId);
    await sendMediaMessage(a, chatId, voice.body.mediaId);
    const voiceMessage = await bVoice;
    expect(voiceMessage.media?.kind).toBe('voice');
    expect(voiceMessage.media?.durationMs).toBe(4_200);
  });

  it('refuses files whose bytes do not match the declared kind', async () => {
    const a = await participant();
    const b = await participant();
    const { chatId } = await matchPair(a, b);

    const html = await uploadMedia(a.identity, chatId, 'image', HTML);
    expect(html.status).toBe(415);
    expect((html.body as unknown as { error: ErrorPayload }).error.code).toBe(
      ErrorCode.MEDIA_TYPE_UNSUPPORTED,
    );

    // A real PNG declared as audio is not "an audio file with an odd name"; the container
    // is what decides.
    const wrongKind = await uploadMedia(a.identity, chatId, 'audio', PNG);
    expect(wrongKind.status).toBe(415);

    // A declared `Content-Type` that contradicts the bytes is refused too.
    const wrongHeader = await uploadMedia(a.identity, chatId, 'image', PNG, {
      contentType: 'image/jpeg',
    });
    expect(wrongHeader.status).toBe(415);
  });

  it('requires a duration for a voice message', async () => {
    const a = await participant();
    const b = await participant();
    const { chatId } = await matchPair(a, b);

    const voice = await uploadMedia(a.identity, chatId, 'voice', WEBM);
    expect(voice.status).toBe(400);
  });

  it('does not let an outsider read, upload or attach', async () => {
    const a = await participant();
    const b = await participant();
    const outsider = await participant();
    const { chatId } = await matchPair(a, b);

    const upload = await uploadMedia(a.identity, chatId, 'image', PNG);
    const mediaId = upload.body.mediaId;

    const read = await downloadMedia(outsider.identity, chatId, mediaId);
    expect(read.status).toBe(404);

    // `NOT_A_PARTICIPANT` is a 409 in this API's status mapping, alongside the other
    // "the chat state says no" errors.
    const write = await uploadMedia(outsider.identity, chatId, 'image', PNG);
    expect(write.status).toBe(409);
    expect((write.body as unknown as { error: ErrorPayload }).error.code).toBe(
      ErrorCode.NOT_A_PARTICIPANT,
    );

    const attach = await sendMediaMessage(outsider, chatId, mediaId);
    expect(attach.ok).toBe(false);
    if (!attach.ok) expect(attach.error.code).toBe(ErrorCode.NOT_A_PARTICIPANT);

    // The peer of the uploader is in the chat, but the upload is not theirs: an id is
    // not a capability.
    const stolen = await sendMediaMessage(b, chatId, mediaId);
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.error.code).toBe(ErrorCode.MEDIA_NOT_FOUND);

    // Still unclaimed after the failed attempts, so the uploader can use it.
    const own = await sendMediaMessage(a, chatId, mediaId);
    expect(own.ok).toBe(true);
  });

  it('cannot attach one upload twice, or into another chat', async () => {
    const a = await participant();
    const b = await participant();
    const { chatId } = await matchPair(a, b);

    const upload = await uploadMedia(a.identity, chatId, 'image', PNG);
    const first = await sendMediaMessage(a, chatId, upload.body.mediaId);
    expect(first.ok).toBe(true);

    const second = await sendMediaMessage(a, chatId, upload.body.mediaId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe(ErrorCode.MEDIA_NOT_FOUND);

    // A different chat (the uploader leaves and matches someone else) must not accept the
    // id either.
    await a.emit('chat:leave', { chatId });
    await b.emit('chat:leave', { chatId });

    const c = await participant();
    const next = await matchAgain(a, c);
    expect(next.chatId).not.toBe(chatId);

    const crossChat = await sendMediaMessage(a, next.chatId, upload.body.mediaId);
    expect(crossChat.ok).toBe(false);
    if (!crossChat.ok) expect(crossChat.error.code).toBe(ErrorCode.MEDIA_NOT_FOUND);
  });

  it('treats a retried message as one message, without losing its attachment', async () => {
    const a = await participant();
    const b = await participant();
    const { chatId } = await matchPair(a, b);

    const upload = await uploadMedia(a.identity, chatId, 'image', PNG);
    const clientMessageId = 'retry-media-once';

    const first = await sendMediaMessage(a, chatId, upload.body.mediaId, { clientMessageId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The retry carries the same media id; the server must answer with the first message
    // rather than reject the attachment as already used.
    const retry = await sendMediaMessage(a, chatId, upload.body.mediaId, { clientMessageId });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.messageId).toBe(first.data.messageId);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const duplicates = b
      .eventsNamed('chat:message')
      .map((payload) => payload as ChatMessageView)
      .filter((message) => message.media?.mediaId === upload.body.mediaId);
    expect(duplicates).toHaveLength(1);
  });

  it('rejects an empty body and an oversized upload', async () => {
    const a = await participant();
    const b = await participant();
    const { chatId } = await matchPair(a, b);

    const empty = await uploadMedia(a.identity, chatId, 'image', new Uint8Array());
    expect(empty.status).toBe(400);

    // One byte over the image ceiling. Sending it is the only way to prove the route's
    // own body limit, not just the store's.
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    oversized.set(PNG.subarray(0, PNG.length));
    const tooLarge = await http<{ error: ErrorPayload }>(`/chats/${chatId}/media?kind=image`, {
      method: 'POST',
      cookie: a.identity.cookie,
      rawBody: oversized,
    });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error.code).toBe(ErrorCode.MEDIA_TOO_LARGE);
  });

  it('requires an identity to upload or download', async () => {
    const a = await participant();
    const b = await participant();
    const { chatId } = await matchPair(a, b);

    const upload = await uploadMedia(a.identity, chatId, 'image', PNG);
    const anonymousUpload = await http(`/chats/${chatId}/media?kind=image`, {
      method: 'POST',
      rawBody: PNG,
    });
    expect(anonymousUpload.status).toBe(401);

    const anonymousRead = await http(`/chats/${chatId}/media/${upload.body.mediaId}`);
    expect(anonymousRead.status).toBe(401);
  });
});
