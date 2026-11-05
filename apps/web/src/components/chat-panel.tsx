'use client';

import {
  Ban,
  Check,
  CircleAlert,
  CornerDownLeft,
  Flag,
  ImagePlus,
  LoaderCircle,
  LogOut,
  MessageSquare,
  Music,
  RefreshCw,
  Search,
  SkipForward,
  Timer,
  TriangleAlert,
  UserCheck,
  UserPlus,
  UserRound,
  WifiOff,
} from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';

import {
  MEDIA_AUDIO_MAX_DURATION_MS,
  MEDIA_MAX_BYTES,
  mediaAcceptAttribute,
  type ChatMediaKind,
} from '@anonlink/shared';

import { AdSlot } from '@/components/ad-slot';
import { MessageMedia } from '@/components/message-media';
import { VoiceRecorder } from '@/components/voice-recorder';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { client } from '@/lib/anonymous-client';
import { describeChatEnd } from '@/lib/error-text';
import { formatRemaining, formatTime } from '@/lib/format';
import { fitsMediaLimit, prepareImageFile, readAudioDuration } from '@/lib/media-files';
import { useTicker } from '@/lib/use-ticker';
import { cn } from '@/lib/utils';
import { useAppStore, type ChatInfo, type UiMessage } from '@/store/app-store';

export interface ChatPanelProps {
  chat: ChatInfo;
  /**
   * Whether the user has the block feature switched on.
   *
   * With it off, the action is not offered at all — the block list at the bottom of the
   * main page stays visible, because an old block must remain removable (docs/DECISIONS.md
   * D31). The server refuses the call either way, so this is the interface agreeing with the
   * rule, not enforcing it.
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
  const { locale, t } = useI18n();
  const messages = useAppStore((state) => state.messages);
  const peerAway = useAppStore((state) => state.peerAway);
  const ended = useAppStore((state) => state.endedChat);
  const maxLength = useAppStore((state) => state.messageMaxLength);
  const clearConversation = useAppStore((state) => state.clearConversation);
  const friendsInChat = useAppStore((state) => state.friendsInChat);
  const incomingFriendRequest = useAppStore((state) => state.incomingFriendRequest);
  const outgoingFriendRequest = useAppStore((state) => state.outgoingFriendRequest);
  const friendRequestOutcome = useAppStore((state) => state.friendRequestOutcome);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  /** True while an attachment is being prepared, uploaded and published. */
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  // Countdown for the outgoing friend request, if there is one.
  const now = useTicker(outgoingFriendRequest !== null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

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

  /**
   * Uploads one prepared attachment.
   *
   * The current draft becomes the caption and is cleared only after the message is
   * acknowledged, so a failed upload leaves the typed text where the user left it.
   */
  async function uploadAttachment(
    blob: Blob,
    kind: ChatMediaKind,
    durationMs?: number,
  ): Promise<void> {
    const caption = draft.trim();
    const outcome = await client.sendMedia({
      blob,
      kind,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(caption ? { caption } : {}),
    });

    if (outcome.ok) {
      setDraft('');
      composerRef.current?.focus();
    } else {
      setAttachmentError(outcome.error);
    }
  }

  /** Rejects an attachment whose caption would exceed the server's message limit. */
  function captionTooLong(): boolean {
    if (draft.length <= maxLength) return false;
    setAttachmentError(
      t('Сообщение слишком длинное — сократите его на {count} симв.', {
        count: draft.length - maxLength,
      }),
    );
    return true;
  }

  async function handlePhotoPicked(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // Reset first so picking the same file twice still fires `change`.
    event.target.value = '';
    if (!file || ended || attachmentBusy || captionTooLong()) return;

    setAttachmentError(null);
    setAttachmentBusy(true);
    try {
      // Re-encoded before the size check: a modern phone photo is often above the limit
      // as stored and comfortably below it once scaled down.
      const prepared = await prepareImageFile(file);
      if (!fitsMediaLimit('image', prepared.size)) {
        setAttachmentError(
          t('Файл больше {size} МБ — выберите изображение поменьше.', {
            size: Math.round(MEDIA_MAX_BYTES.image / (1024 * 1024)),
          }),
        );
        return;
      }
      await uploadAttachment(prepared, 'image');
    } catch {
      setAttachmentError(t('Не удалось обработать изображение. Попробуйте другое.'));
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function handleAudioPicked(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || ended || attachmentBusy || captionTooLong()) return;

    setAttachmentError(null);
    setAttachmentBusy(true);
    try {
      if (!fitsMediaLimit('audio', file.size)) {
        setAttachmentError(
          t('Файл больше {size} МБ — выберите аудиофайл поменьше.', {
            size: Math.round(MEDIA_MAX_BYTES.audio / (1024 * 1024)),
          }),
        );
        return;
      }

      const durationMs = await readAudioDuration(file);
      if (durationMs !== null && durationMs > MEDIA_AUDIO_MAX_DURATION_MS) {
        setAttachmentError(
          t('Аудиофайл длиннее {minutes} минут.', {
            minutes: Math.round(MEDIA_AUDIO_MAX_DURATION_MS / 60_000),
          }),
        );
        return;
      }

      await uploadAttachment(file, 'audio', durationMs ?? undefined);
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function handleVoiceRecorded(blob: Blob, durationMs: number): Promise<void> {
    if (ended || attachmentBusy) return;
    setAttachmentError(null);
    setAttachmentBusy(true);
    try {
      await uploadAttachment(blob, 'voice', durationMs);
    } finally {
      setAttachmentBusy(false);
    }
  }

  // Offering "write again" to someone the user just blocked would be a button that can
  // only fail: the server refuses a new request to a blocked User ID. The end reason is
  // exactly the signal for this — it says `blocked` for the person who blocked, and
  // `peer_left` for the other side.
  const peerPublicId = chat.peerPublicId;
  const canWriteAgain = chat.kind === 'direct' && ended?.reason !== 'blocked';

  const friendOutcomeLabel =
    friendRequestOutcome === 'declined'
      ? t('Заявка отклонена')
      : friendRequestOutcome === 'expired'
        ? t('Время истекло')
        : friendRequestOutcome === 'unavailable' || friendRequestOutcome === 'cancelled'
          ? t('Недоступно')
          : null;
  const friendLabel = friendsInChat
    ? t('Вы друзья')
    : outgoingFriendRequest
      ? t('Запрос отправлен')
      : incomingFriendRequest
        ? t('Заявка в друзья')
        : (friendOutcomeLabel ?? t('В друзья'));
  const canRequestFriend =
    !ended &&
    !friendsInChat &&
    !outgoingFriendRequest &&
    !incomingFriendRequest &&
    friendRequestOutcome === null &&
    !busy;

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
              {chat.kind === 'random' ? t('случайный') : t('по User ID')}
            </Badge>

            {peerAway && !ended ? (
              <Badge variant="warning">
                <WifiOff className="size-3.5" aria-hidden="true" />
                {t('собеседник отключился')}
              </Badge>
            ) : null}
          </div>

          {chat.peerPublicId ? (
            /*
              `translate="no"` on the ID only: browser translators must keep translating the
              interface and the messages (docs/DECISIONS.md D29), but a User ID is not a word.
              Left translatable, it comes back with the letters swapped or the dashes moved,
              and the user copies something that no longer resolves.
            */
            <code translate="no" className="font-mono text-xs text-muted-foreground">
              {chat.peerPublicId}
            </code>
          ) : null}
        </div>

        {!ended ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!canRequestFriend}
              onClick={() => void run(() => client.requestFriend())}
            >
              {friendsInChat ? (
                <UserCheck className="size-4" aria-hidden="true" />
              ) : (
                <UserPlus className="size-4" aria-hidden="true" />
              )}
              <span className="sr-only sm:not-sr-only">{friendLabel}</span>
            </Button>
            {canBlock ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={onBlock}>
                <Ban className="size-4" aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">{t('Блокировать')}</span>
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" disabled={busy} onClick={onReport}>
              <Flag className="size-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">{t('Жалоба')}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => client.nextPeer())}
            >
              <SkipForward className="size-4" aria-hidden="true" />
              {t('Следующий')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => client.leaveChat())}
            >
              <LogOut className="size-4" aria-hidden="true" />
              {t('Завершить')}
            </Button>
          </div>
        ) : null}
      </CardHeader>

      {!ended && outgoingFriendRequest ? (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-card px-4 py-2 text-xs text-muted-foreground"
          role="status"
        >
          <Timer className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span>{t('Запрос в друзья отправлен.')}</span>
          <span>{t('Истекает через:')}</span>
          <span className="font-mono tabular-nums">
            {formatRemaining(outgoingFriendRequest.expiresAt, now, locale)}
          </span>
        </div>
      ) : null}

      {/* --- transcript ----------------------------------------------------- */}
      <CardContent
        className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-4"
        role="log"
        aria-live="polite"
        aria-label={t('Переписка')}
      >
        {messages.length === 0 && !ended ? (
          <p className="mx-auto flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-center text-sm text-muted-foreground">
            <MessageSquare className="size-4" aria-hidden="true" />
            {t('Напишите первое сообщение.')}
          </p>
        ) : null}

        {messages.map((message) => (
          <MessageBubble key={message.key} message={message} chatId={chat.chatId} />
        ))}

        <div ref={bottomRef} />
      </CardContent>

      {/* --- composer or end state ------------------------------------------ */}
      {ended ? (
        <div className="flex flex-col gap-3 border-t border-border bg-muted p-4">
          <p className="flex items-center gap-2 text-sm">
            <CircleAlert className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {describeChatEnd(ended.reason, locale)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void run(() => client.nextPeer())}>
              <SkipForward className="size-4" aria-hidden="true" />
              {t('Найти нового собеседника')}
            </Button>
            {canWriteAgain && peerPublicId ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => client.requestDirect(peerPublicId))}
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                {t('Написать снова')}
              </Button>
            ) : null}
            {/*
              Without this the finished conversation is a dead end: "Найти нового
              собеседника" is the only way out of it, so reaching the "По User ID" tab or
              the settings would require starting a search and cancelling it again.
            */}
            <Button variant="ghost" disabled={busy} onClick={clearConversation}>
              <Check className="size-4" aria-hidden="true" />
              {t('Готово')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-t border-border bg-card p-3">
          <label className="sr-only" htmlFor="chat-composer">
            {t('Сообщение')}
          </label>

          {/*
            File inputs are hidden and opened by their visible buttons. They are not
            `display:none` for the end-to-end suite: Playwright sets a file directly on
            the input, which needs it to be present in the DOM, not necessarily visible.
          */}
          <input
            ref={photoInputRef}
            type="file"
            accept={mediaAcceptAttribute('image')}
            className="hidden"
            onChange={(event) => void handlePhotoPicked(event)}
          />
          <input
            ref={audioInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(event) => void handleAudioPicked(event)}
          />

          <div className="flex items-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-10 shrink-0"
              disabled={attachmentBusy || ended !== null}
              onClick={() => photoInputRef.current?.click()}
              aria-label={t('Прикрепить фото')}
              title={t('Прикрепить фото')}
            >
              <ImagePlus className="size-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-10 shrink-0"
              disabled={attachmentBusy || ended !== null}
              onClick={() => audioInputRef.current?.click()}
              aria-label={t('Прикрепить аудиофайл')}
              title={t('Прикрепить аудиофайл')}
            >
              <Music className="size-4" aria-hidden="true" />
            </Button>

            <Textarea
              id="chat-composer"
              ref={composerRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              dir="auto"
              placeholder={t('Введите сообщение…')}
              className="max-h-40 min-h-10"
              aria-invalid={tooLong}
              {...(tooLong ? { 'aria-describedby': 'composer-length' } : {})}
            />

            <VoiceRecorder
              disabled={attachmentBusy || ended !== null}
              onRecorded={(blob, durationMs) => void handleVoiceRecorded(blob, durationMs)}
              onError={setAttachmentError}
            />

            <Button className="h-10" disabled={!canSend} onClick={send}>
              <CornerDownLeft className="size-4" aria-hidden="true" />
              {t('Отправить')}
            </Button>
          </div>

          {attachmentBusy ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              {t('Отправляем вложение…')}
            </p>
          ) : null}

          {attachmentError ? (
            <p className="text-xs text-destructive" role="alert">
              {attachmentError}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            {/*
              The keyboard hint is *visible* text rather than part of the placeholder:
              browser translators do not translate `placeholder` attributes, and a Chinese
              user would keep a Russian instruction inside the field (docs/DECISIONS.md D29).
            */}
            <span>
              {t(
                'Enter — отправить, Shift+Enter — новая строка. Можно прикрепить фото, аудио или записать голосовое.',
              )}
            </span>
            {/* Only shown near the limit, so it is a warning rather than noise. */}
            {draft.length > maxLength * 0.8 ? (
              <span
                id="composer-length"
                translate="no"
                className={cn('font-mono tabular-nums', tooLong && 'text-destructive')}
              >
                {draft.length}/{maxLength}
              </span>
            ) : null}
          </div>

          {tooLong ? (
            <p className="text-xs text-destructive" role="alert">
              {t('Сообщение слишком длинное — сократите его на {count} симв.', {
                count: draft.length - maxLength,
              })}
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/** One message bubble. `from` is decided by the server, never guessed locally. */
function MessageBubble({ message, chatId }: { message: UiMessage; chatId: string }) {
  const { locale, t } = useI18n();

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
        {message.media ? <MessageMedia chatId={chatId} media={message.media} mine={mine} /> : null}

        {message.text ? (
          /*
            The message is one text node, deliberately: browser translators translate per
            text node, and a message split across spans (linkified words, per-word styling)
            reaches the translator as unrelated fragments and comes back as nonsense
            (docs/DECISIONS.md D29).

            `lang=""` means "language unknown", so a translator detects the language of this
            message instead of assuming the interface language. `dir="auto"` picks the writing
            direction from the first strong character — without it an Arabic or Hebrew message
            is rendered left-to-right because the page is Russian.
          */
          <span
            lang=""
            dir="auto"
            className={cn('break-words whitespace-pre-wrap', message.media && 'mt-1 block')}
          >
            {message.text}
          </span>
        ) : null}

        <span
          className={cn(
            'mt-0.5 flex items-center justify-end gap-1 text-[11px]',
            mine && !failed ? 'text-primary-foreground/70' : 'text-muted-foreground',
          )}
        >
          {formatTime(message.sentAt, locale)}
          {message.status === 'sending' ? (
            <>
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
              {t('отправляется')}
            </>
          ) : null}
          {failed ? (
            <>
              <TriangleAlert className="size-3" aria-hidden="true" />
              {message.failureReason
                ? t('не отправлено: {reason}', { reason: message.failureReason })
                : t('не отправлено')}
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
  const { t } = useI18n();

  return (
    <Card className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
      <Search className="size-5 animate-pulse text-primary" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{t('Открываем чат…')}</p>
    </Card>
  );
}
