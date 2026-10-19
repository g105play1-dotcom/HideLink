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

import { AdSlot } from '@/components/ad-slot';
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
  /**
   * Whether the user has the block feature switched on.
   *
   * With it off, the action is not offered at all — the same setting also hides the
   * blocked list in the settings (docs/DECISIONS.md D24). The server refuses the call
   * either way, so this is the interface agreeing with the rule, not enforcing it.
   */
  canBlock: boolean;
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
export function ChatPanel({ chat, canBlock, onReport, onBlock }: ChatPanelProps) {
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
      // `isolate` + `relative` make the card its own stacking context, which is what lets
      // the advertising layer above paint *behind* the conversation instead of over it.
      className="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden"
      // The chat id is not a secret (only the two participants ever see it, and it names
      // an ephemeral conversation), and it is the one stable handle the end-to-end suite
      // needs to prove a third party cannot write into someone else's chat.
      data-chat-id={chat.chatId}
    >
      {/*
        Reserved advertising layer behind the conversation (docs/DECISIONS.md D23). Empty
        today and painting nothing. Readability does not depend on it staying empty: every
        message — including system notices — is drawn on its own opaque bubble, and the
        header and composer are opaque bars, so a creative can only ever show in the gaps
        between bubbles.
      */}
      <AdSlot variant="chat-background" className="-z-10" />

      {/* --- header --------------------------------------------------------- */}
      <CardHeader className="flex-row items-center justify-between gap-3 border-b border-border bg-muted py-3">
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
            {canBlock ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={onBlock}>
                <Ban className="size-4" aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">Блокировать</span>
              </Button>
            ) : null}
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
          <p className="mx-auto flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-center text-sm text-muted-foreground">
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
        <div className="flex flex-col gap-3 border-t border-border bg-muted p-4">
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
        <div className="flex flex-col gap-2 border-t border-border bg-card p-3">
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
      <p className="mx-auto flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-center text-xs text-muted-foreground">
        <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
        {message.text}
      </p>
    );
  }

  const mine = message.from === 'you';
  const failed = message.status === 'failed';

  /*
    Everything about a message lives inside its bubble, including the timestamp and the
    delivery state — the Telegram shape the owner asked for. It is not only a matter of
    taste: the bubble is the opaque surface that keeps a message readable, and a
    timestamp drawn on the background next to it would be the first thing an advertising
    creative behind the conversation made illegible.
  */
  return (
    <div className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm',
          mine ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
          failed && 'bg-destructive text-destructive-foreground',
        )}
      >
        <span className="break-words whitespace-pre-wrap">{message.text}</span>

        <span
          className={cn(
            'mt-0.5 flex items-center justify-end gap-1 text-[11px]',
            mine && !failed ? 'text-primary-foreground/70' : 'text-muted-foreground',
          )}
        >
          {formatTime(message.sentAt)}
          {message.status === 'sending' ? (
            <>
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
              отправляется
            </>
          ) : null}
          {failed ? (
            <>
              <TriangleAlert className="size-3" aria-hidden="true" />
              не отправлено{message.failureReason ? `: ${message.failureReason}` : ''}
            </>
          ) : null}
        </span>
      </div>
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
