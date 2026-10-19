'use client';

import {
  Ban,
  Check,
  CircleAlert,
  CornerDownLeft,
  Flag,
  LoaderCircle,
  LogOut,
  MessageSquare,
  RefreshCw,
  Search,
  SkipForward,
  TriangleAlert,
  UserRound,
  WifiOff,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { client } from '@/lib/anonymous-client';
import { describeChatEnd } from '@/lib/error-text';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAppStore, type ChatInfo, type UiMessage } from '@/store/app-store';

export interface ChatPanelProps {
  chat: ChatInfo;
  /** Opens the report dialog, which is owned by the screen above. */
  onReport: () => void;
  /** Opens the block confirmation, also owned by the screen above. */
  onBlock: () => void;
}

/**
 * An active (or just-finished) conversation.
 *
 * The transcript stays visible after the chat ends — the user should be able to read
 * what was said, and the reason it ended, rather than watching the screen clear.
 */
export function ChatPanel({ chat, onReport, onBlock }: ChatPanelProps) {
  const messages = useAppStore((state) => state.messages);
  const peerAway = useAppStore((state) => state.peerAway);
  const ended = useAppStore((state) => state.endedChat);
  const maxLength = useAppStore((state) => state.messageMaxLength);
  const clearConversation = useAppStore((state) => state.clearConversation);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Keep the newest message in view as the conversation grows.
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, ended]);

  const trimmedLength = draft.trim().length;
  const tooLong = draft.length > maxLength;
  const canSend = !ended && trimmedLength > 0 && !tooLong;

  function send() {
    const text = draft.trim();
    if (!text || tooLong || ended) return;

    client.sendMessage(text);
    setDraft('');
    composerRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter inserts a line break — the convention users expect.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  // Offering "write again" to someone the user just blocked would be a button that can
  // only fail: the server refuses a new request to a blocked User ID. The end reason is
  // exactly the signal for this — it says `blocked` for the person who blocked, and
  // `peer_left` for the other side.
  const peerPublicId = chat.peerPublicId;
  const canWriteAgain = chat.kind === 'direct' && ended?.reason !== 'blocked';

  return (
    <Card
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      // The chat id is not a secret (only the two participants ever see it, and it names
      // an ephemeral conversation), and it is the one stable handle the end-to-end suite
      // needs to prove a third party cannot write into someone else's chat.
      data-chat-id={chat.chatId}
    >
      {/* --- header --------------------------------------------------------- */}
      <CardHeader className="flex-row items-center justify-between gap-3 border-b border-border bg-muted/40 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <UserRound className="size-4 text-primary" aria-hidden="true" />
              {chat.peerAlias}
            </span>

            <Badge variant={chat.kind === 'random' ? 'default' : 'accent'}>
              {chat.kind === 'random' ? 'случайный' : 'по User ID'}
            </Badge>

            {peerAway && !ended ? (
              <Badge variant="warning">
                <WifiOff className="size-3.5" aria-hidden="true" />
                собеседник отключился
              </Badge>
            ) : null}
          </div>

          {chat.peerPublicId ? (
            <code className="font-mono text-xs text-muted-foreground">{chat.peerPublicId}</code>
          ) : null}
        </div>

        {!ended ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={onBlock}>
              <Ban className="size-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Блокировать</span>
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onReport}>
              <Flag className="size-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Жалоба</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => client.nextPeer())}
            >
              <SkipForward className="size-4" aria-hidden="true" />
              Следующий
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => client.leaveChat())}
            >
              <LogOut className="size-4" aria-hidden="true" />
              Завершить
            </Button>
          </div>
        ) : null}
      </CardHeader>

      {/* --- transcript ----------------------------------------------------- */}
      <CardContent
        className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-4"
        role="log"
        aria-live="polite"
        aria-label="Переписка"
      >
        {messages.length === 0 && !ended ? (
          <p className="flex flex-1 items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <MessageSquare className="size-4" aria-hidden="true" />
            Напишите первое сообщение.
          </p>
        ) : null}

        {messages.map((message) => (
          <MessageBubble key={message.key} message={message} />
        ))}

        <div ref={bottomRef} />
      </CardContent>

      {/* --- composer or end state ------------------------------------------ */}
      {ended ? (
        <div className="flex flex-col gap-3 border-t border-border bg-muted/40 p-4">
          <p className="flex items-center gap-2 text-sm">
            <CircleAlert className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {describeChatEnd(ended.reason)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void run(() => client.nextPeer())}>
              <SkipForward className="size-4" aria-hidden="true" />
              Найти нового собеседника
            </Button>
            {canWriteAgain && peerPublicId ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => client.requestDirect(peerPublicId))}
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                Написать снова
              </Button>
            ) : null}
            {/*
              Without this the finished conversation is a dead end: "Найти нового
              собеседника" is the only way out of it, so reaching the "По User ID" tab or
              the settings would require starting a search and cancelling it again.
            */}
            <Button variant="ghost" disabled={busy} onClick={clearConversation}>
              <Check className="size-4" aria-hidden="true" />
              Готово
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-t border-border p-3">
          <label className="sr-only" htmlFor="chat-composer">
            Сообщение
          </label>
          <div className="flex items-end gap-2">
            <Textarea
              id="chat-composer"
              ref={composerRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder="Введите сообщение… (Enter — отправить, Shift+Enter — новая строка)"
              className="max-h-40 min-h-10"
              aria-invalid={tooLong}
              {...(tooLong ? { 'aria-describedby': 'composer-length' } : {})}
            />
            <Button className="h-10" disabled={!canSend} onClick={send}>
              <CornerDownLeft className="size-4" aria-hidden="true" />
              Отправить
            </Button>
          </div>

          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Текстовые сообщения.</span>
            {/* Only shown near the limit, so it is a warning rather than noise. */}
            {draft.length > maxLength * 0.8 ? (
              <span
                id="composer-length"
                className={cn('font-mono tabular-nums', tooLong && 'text-destructive')}
              >
                {draft.length}/{maxLength}
              </span>
            ) : null}
          </div>

          {tooLong ? (
            <p className="text-xs text-destructive" role="alert">
              Сообщение слишком длинное — сократите его на {draft.length - maxLength} симв.
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/** One message bubble. `from` is decided by the server, never guessed locally. */
function MessageBubble({ message }: { message: UiMessage }) {
  if (message.from === 'system') {
    return (
      <p className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
        <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
        {message.text}
      </p>
    );
  }

  const mine = message.from === 'you';

  return (
    <div className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm break-words whitespace-pre-wrap',
          mine ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
          message.status === 'failed' && 'bg-destructive text-destructive-foreground',
        )}
      >
        {message.text}
      </div>

      <span className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
        {formatTime(message.sentAt)}
        {message.status === 'sending' ? (
          <>
            <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> отправляется
          </>
        ) : null}
        {message.status === 'failed' ? (
          <>
            <TriangleAlert className="size-3 text-destructive" aria-hidden="true" />
            <span className="text-destructive">
              не отправлено{message.failureReason ? `: ${message.failureReason}` : ''}
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Idle placeholder shown while a chat is being established.
 *
 * Not decorative: it is the state between "matched" and "first message", and it is
 * rendered instead of an empty card so the transition never looks like a glitch.
 */
export function ChatConnecting() {
  return (
    <Card className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
      <Search className="size-5 animate-pulse text-primary" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">Открываем чат…</p>
    </Card>
  );
}
