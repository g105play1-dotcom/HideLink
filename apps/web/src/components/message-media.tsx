'use client';

import { ImageOff, LoaderCircle, Mic } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ChatMediaView } from '@anonlink/shared';

import { useI18n } from '@/i18n';
import { translate, type MessageKey } from '@/i18n/messages';
import { formatDuration } from '@/lib/format';
import { apiBlob } from '@/lib/http';
import { cn } from '@/lib/utils';

type MediaState = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error' };

/**
 * One attachment inside a message bubble.
 *
 * The bytes are fetched with the session cookie and turned into an object URL that lives
 * only in this tab. There is deliberately no `<img src="/api/…">`: a plain URL would be
 * attached to the request by the browser without the component being able to react to a
 * revoked session or a chat ending, and it would be shareable in a way an anonymous
 * conversation must not be. The object URL is revoked when the bubble unmounts or the
 * transcript is cleared.
 *
 * `admin` selects the owner's guarded route. The owner is not a participant in a hidden
 * chat, so the participant-checked route would rightly refuse them.
 */
export function MessageMedia({
  chatId,
  media,
  admin = false,
  mine = false,
}: {
  chatId: string;
  media: ChatMediaView;
  admin?: boolean;
  mine?: boolean;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<MediaState>({ status: 'loading' });

  // `/admin` is Russian-only by design (docs/DECISIONS.md D29), and it does not switch
  // the public interface language. The attachment labels follow the screen, not the tab.
  const label = (key: MessageKey): string => (admin ? translate('ru', key) : t(key));

  const path = admin
    ? `/admin/chats/${encodeURIComponent(chatId)}/media/${encodeURIComponent(media.mediaId)}`
    : `/chats/${encodeURIComponent(chatId)}/media/${encodeURIComponent(media.mediaId)}`;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    void apiBlob(path)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', url: objectUrl });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (state.status === 'loading') {
    return (
      <div
        className={cn(
          'flex min-h-24 w-56 items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-4 text-xs',
          mine
            ? 'border-primary-foreground/40 text-primary-foreground/80'
            : 'border-border text-muted-foreground',
        )}
        role="status"
      >
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        {label('Загрузка вложения…')}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div
        className={cn(
          'flex min-h-24 w-56 flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-3 py-4 text-center text-xs',
          mine
            ? 'border-primary-foreground/40 text-primary-foreground/80'
            : 'border-border text-muted-foreground',
        )}
        role="status"
      >
        <ImageOff className="size-4" aria-hidden="true" />
        {label('Вложение недоступно')}
      </div>
    );
  }

  if (media.kind === 'image') {
    return (
      <a
        href={state.url}
        target="_blank"
        rel="noreferrer"
        className="block overflow-hidden rounded-xl"
        // The object URL is local to this tab; calling it a link is still the honest
        // description of what happens when it is clicked.
        aria-label={label('Открыть изображение')}
      >
        {/* A blob: URL cannot go through `next/image`, which needs a static or remote path. */}
        <img
          src={state.url}
          alt={label('Изображение')}
          className="max-h-72 w-auto max-w-full object-contain"
          draggable={false}
        />
      </a>
    );
  }

  const durationMs = media.durationMs;

  return (
    <div className="flex w-64 max-w-full flex-col gap-1">
      <div className="flex items-center gap-2">
        {media.kind === 'voice' ? (
          <Mic
            className={cn('size-4 shrink-0', mine ? 'text-primary-foreground/80' : 'text-primary')}
            aria-hidden="true"
          />
        ) : null}
        <audio
          controls
          preload="metadata"
          src={state.url}
          className="h-9 w-full min-w-0"
          aria-label={media.kind === 'voice' ? label('Голосовое сообщение') : label('Аудиофайл')}
        />
      </div>
      {durationMs !== undefined ? (
        <span
          className={cn(
            'text-[11px] tabular-nums',
            mine ? 'text-primary-foreground/70' : 'text-muted-foreground',
          )}
        >
          {formatDuration(durationMs)}
        </span>
      ) : null}
    </div>
  );
}
