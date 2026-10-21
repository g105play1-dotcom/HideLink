'use client';

import { Check, LoaderCircle, Timer, UserRoundPlus, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { client } from '@/lib/anonymous-client';
import { formatRemaining } from '@/lib/format';
import { useTicker } from '@/lib/use-ticker';
import { useAppStore } from '@/store/app-store';

/**
 * An incoming friend request, shown over the conversation.
 *
 * This is the only moment at which a random-match peer can ask for a persistent link.
 * The request must be answered while the chat is alive; closing the tab or ending the
 * chat cancels it. Only an explicit acceptance reveals either User ID.
 */
export function IncomingFriendRequestDialog() {
  const { locale, t } = useI18n();
  const request = useAppStore((state) => state.incomingFriendRequest);
  const clearFriendRequest = useAppStore((state) => state.clearFriendRequest);
  const setFriendRequestOutcome = useAppStore((state) => state.setFriendRequestOutcome);
  const [busy, setBusy] = useState(false);

  const now = useTicker(request !== null);

  if (!request) return null;

  const expired = new Date(request.expiresAt).getTime() <= now;

  async function respond(accept: boolean) {
    if (!request) return;
    setBusy(true);
    try {
      await client.respondToFriendRequest(request.requestId, accept);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      dismissible={false}
      title={t('Добавить {alias} в друзья?', { alias: request.alias })}
      description={t(
        'Собеседник предлагает стать друзьями. Это взаимно: вы увидите User ID друг друга и сможете писать друг другу в любое время.',
      )}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2">
          <UserRoundPlus className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 truncate text-sm font-medium">{request.alias}</span>
        </div>

        {expired ? (
          <>
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Timer className="size-4 shrink-0" aria-hidden="true" />
              {t('Время заявки в друзья истекло.')}
            </p>
            <div className="flex justify-end">
              <Button
                variant="ghost"
                onClick={() => {
                  clearFriendRequest(request.requestId);
                  setFriendRequestOutcome('expired');
                }}
              >
                {t('Закрыть')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <span>{t('Истекает через:')}</span>
              <span className="font-mono tabular-nums">
                {formatRemaining(request.expiresAt, now, locale)}
              </span>
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => void respond(false)} disabled={busy}>
                <X className="size-4" aria-hidden="true" />
                {t('Отклонить')}
              </Button>
              <Button onClick={() => void respond(true)} disabled={busy}>
                {busy ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Check className="size-4" aria-hidden="true" />
                )}
                {t('Принять')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
