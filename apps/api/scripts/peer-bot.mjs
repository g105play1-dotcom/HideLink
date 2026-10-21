#!/usr/bin/env node
/**
 * A second AnonLink participant, for testing by hand.
 *
 * AnonLink is a two-person chat, so trying it in one browser means every tab shares the
 * same session cookie — the "other person" is you, and the app quite correctly refuses
 * to match you with yourself. This script is the missing second person: a real client
 * that speaks the same WebSocket protocol as the web app.
 *
 * Usage (from the repository root):
 *
 *   node apps/api/scripts/peer-bot.mjs
 *     Joins the random queue and replies to every message it receives.
 *
 *   node apps/api/scripts/peer-bot.mjs --listen
 *     Stays online and accepts any direct request that arrives. Prints its User ID,
 *     which you can paste into the web app's "Написать по User ID" field.
 *
 *   node apps/api/scripts/peer-bot.mjs --direct AL7KM39PQ2XRZ4
 *     Sends a direct request to that User ID and chats if it is accepted.
 *
 * Options:
 *   --api <url>   API base URL (default: API_URL or http://localhost:3001)
 *   --origin <o>  Origin header to send (default: CORS_ORIGINS' first entry)
 *   --quiet       Only print the important lines.
 *
 * It never writes anything to disk and exits on Ctrl+C.
 */

import { io } from 'socket.io-client';

const API_URL = readOption('api') ?? process.env.API_URL ?? 'http://localhost:3001';
const ORIGIN = readOption('origin') ?? process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const DIRECT_TO = readOption('direct');
const LISTEN_ONLY = hasFlag('listen');
const QUIET = hasFlag('quiet');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readOption(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const stamp = () => new Date().toLocaleTimeString('ru-RU');

function say(...parts) {
  console.log(`[${stamp()}]`, ...parts);
}

function detail(...parts) {
  if (!QUIET) say(...parts);
}

/** Creates an anonymous identity and returns the session cookie header. */
async function createIdentity() {
  const response = await fetch(`${API_URL}/api/v1/session`, { method: 'POST' });

  if (!response.ok) {
    throw new Error(
      `POST /session failed with ${response.status}. Is the API running at ${API_URL}?`,
    );
  }

  const body = await response.json();
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('anonlink_session'));

  if (!cookie) throw new Error('The API did not set a session cookie.');

  return { publicId: body.publicId, cookie: cookie.split(';')[0] };
}

const identity = await createIdentity();

say(`User ID: ${identity.publicId}`);
say(`API:     ${API_URL}`);

const socket = io(API_URL, {
  transports: ['websocket'],
  extraHeaders: { cookie: identity.cookie, origin: ORIGIN },
  reconnection: true,
  reconnectionDelay: 500,
});

let chatId = null;
let lastPeerName = 'собеседник';

socket.on('connect', () => detail('connection: connected'));
socket.on('disconnect', (reason) => detail(`connection: disconnected (${reason})`));

socket.on('session:ready', (payload) => {
  detail(
    `session: ready, protocol v${payload.protocolVersion}, limits: ${payload.limits.messageMaxLength} chars`,
  );

  if (payload.activeChat) {
    // After a reconnect the conversation is still there; only the transcript is new.
    chatId = payload.activeChat.chatId;
    detail(`resumed chat ${chatId}`);
    return;
  }

  if (DIRECT_TO) {
    socket.emit(
      'request:send',
      { publicId: DIRECT_TO, note: 'Привет! Это тестовый бот.' },
      (ack) => {
        if (ack.ok) say(`direct request sent to ${DIRECT_TO}, expires ${ack.data.expiresAt}`);
        else say(`direct request failed: ${ack.error.code} (${ack.error.message})`);
      },
    );
    return;
  }

  if (!LISTEN_ONLY) {
    socket.emit('match:join', (ack) => {
      if (!ack.ok) return say(`match:join failed: ${ack.error.code}`);
      detail(ack.data.queued ? 'waiting in the random queue…' : 'matched immediately');
    });
  } else {
    say('listening for incoming direct requests');
  }
});

socket.on('match:queued', () => detail('in the queue, waiting for someone…'));
socket.on('match:cancelled', (payload) => detail(`search cancelled (${payload.reason})`));

socket.on('chat:started', (payload) => {
  chatId = payload.chat.chatId;
  lastPeerName = payload.chat.peer.alias;
  say(`chat started with "${lastPeerName}" (${payload.chat.kind}) — chat ${chatId}`);
  socket.emit('chat:message', {
    chatId,
    clientMessageId: `bot-${Date.now()}`,
    text: 'Привет! Я тестовый бот. Напиши что-нибудь, и я отвечу.',
  });
});

socket.on('chat:resumed', (payload) => {
  chatId = payload.chat.chatId;
  say(`chat resumed with ${payload.messages.length} message(s) in the transcript`);
});

socket.on('chat:message', (message) => {
  const who = message.from === 'you' ? 'я' : lastPeerName;
  say(`${who}: ${message.text}`);

  // Reply once per incoming message, so the exchange is easy to follow by hand.
  if (message.from === 'peer' && chatId) {
    setTimeout(() => {
      socket.emit('chat:message', {
        chatId,
        clientMessageId: `bot-reply-${Date.now()}`,
        text: `Получил: «${message.text}»`,
      });
    }, 300);
  }
});

socket.on('chat:peer-away', () => say('peer connection dropped — waiting for them to come back…'));
socket.on('chat:peer-back', () => say('peer is back.'));
socket.on('chat:ended', (payload) => {
  say(`chat ended (${payload.reason})`);
  chatId = null;
  if (!DIRECT_TO && !LISTEN_ONLY) {
    setTimeout(() => socket.emit('match:join'), 500);
  }
});

socket.on('request:incoming', (request) => {
  say(`incoming request from ${request.from.publicId}${request.note ? `: «${request.note}»` : ''}`);
  socket.emit('request:respond', { requestId: request.requestId, accept: true }, (ack) => {
    if (!ack.ok) say(`could not answer the request: ${ack.error.code}`);
  });
});

// A friend request is the one question this bot can answer on the human's behalf:
// the script exists to let one person try a two-person feature, and without this
// the "В друзья" button would always expire in a manual test.
socket.on('friend:incoming', (request) => {
  say(`friend request from "${request.alias}" in chat ${request.chatId}, accepting`);
  socket.emit('friend:respond', { requestId: request.requestId, accept: true }, (ack) => {
    if (!ack.ok) say(`could not answer the friend request: ${ack.error.code}`);
  });
});

socket.on('friend:resolved', (payload) => {
  if (payload.status === 'accepted' && payload.friend) {
    say(`now friends with ${payload.friend.publicId} (since ${payload.friend.since})`);
  } else {
    say(`friend request ${payload.status}`);
  }
});

socket.on('friend:removed', (payload) => say(`removed from friends: ${payload.publicId}`));

socket.on('request:resolved', (payload) => say(`request resolved: ${payload.status}`));
socket.on('peer:blocked', (payload) => say(`the peer blocked you (${payload.publicId})`));
socket.on('app:error', (payload) => say(`server error: ${payload.code} — ${payload.message}`));

process.on('SIGINT', () => {
  say('bye');
  socket.close();
  process.exit(0);
});
