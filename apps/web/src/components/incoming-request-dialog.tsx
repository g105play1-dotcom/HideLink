'use client';

import { Bell, Check, Timer, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { client } from '@/lib/anonymous-client';
import { formatRemaining } from '@/lib/format';
import { useTicker } from '@/lib/use-ticker';
import { useAppStore } from '@/store/app-store';

/**
 * Incoming direct-chat request.
 *
 * Only the oldest request is shown, with a count of the rest. Stacking modals would
 * be a mess, and the server caps how many can be pending anyway.
 */
export function IncomingRequestDialog() {
  const { locale, t } = useI18n();
  const requests = useAppStore((state) => state.incomingRequests);
  const [busy, setBusy] = useState(false);

  const current = requests[0];
  const open = current !== undefined;

  // Keeps the expiry countdown live while the prompt is on screen.
  const now = useTicker(open);

  if (!current) return null;

  const waiting = requests.length - 1;
  const expired = new Date(current.expiresAt).getTime() < now;

  async function respond(accept: boolean) {
    setBusy(true);
    try {
      await client.respondToRequest(current?.requestId ?? '', accept);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={t('Хотят начать с вами чат')}
      description={t(
        'Человек нашёл вас по вашему User ID. Он не узнает, примете вы или нет, — увидит только результат.',
      )}
      // Deliberately not dismissible: an unanswered request would stay pending in the
      // background, which is more confusing than answering it.
      dismissible={false}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/50 p-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Bell className="size-4 text-primary" aria-hidden="true" />
            {current.alias}
          </span>
          {current.note ? (
            /*
              The note is written by the *sender*, not by us, so it is marked as unknown
              language and auto-direction: a translator must detect it per message, and an
              Arabic note must not inherit the Russian page direction (docs/DECISIONS.md D29).
            */
            <p
              lang=""
              dir="auto"
              className="text-sm break-words whitespace-pre-wrap text-muted-foreground"
            >
              {current.note}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('Без сообщения.')}</p>
          )}
        </div>

        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          {/*
            The live region holds the *state*, not the countdown: a per-second tick inside
            `role="status"` is announced by a screen reader every second, and a browser
            translator would re-translate the sentence on every tick (docs/DECISIONS.md D29).
          */}
          <p className="flex items-center gap-2" role="status">
            <Timer className="size-3.5 shrink-0" aria-hidden="true" />
            {expired ? t('Время заявки истекло.') : t('Заявка ждёт ответа.')}
          </p>

          {expired ? null : (
            <p className="flex items-center gap-2">
              <span>{t('Истекает через:')}</span>
              <span translate="no" className="font-mono tabular-nums">
                {formatRemaining(current.expiresAt, now, locale)}
              </span>
            </p>
          )}

          {waiting > 0 ? <p>{t('Ещё заявок в очереди: {count}.', { count: waiting })}</p> : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={busy || expired} onClick={() => void respond(false)}>
            <X className="size-4" aria-hidden="true" />
            {t('Отклонить')}
          </Button>
          <Button disabled={busy || expired} onClick={() => void respond(true)}>
            {busy ? (
              <Timer className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="size-4" aria-hidden="true" />
            )}
            {t('Принять')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
