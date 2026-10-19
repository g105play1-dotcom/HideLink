'use client';

import { Bell, Check, Timer, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
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
      title="Хотят начать с вами чат"
      description="Человек нашёл вас по вашему User ID. Он не узнает, примете вы или нет, — увидит только результат."
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
            <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">
              {current.note}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Без сообщения.</p>
          )}
        </div>

        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Timer className="size-3.5 shrink-0" aria-hidden="true" />
          {expired
            ? 'Время заявки истекло.'
            : `Заявка истечёт через ${formatRemaining(current.expiresAt, now)}.`}
          {waiting > 0 ? ` Ещё заявок в очереди: ${waiting}.` : ''}
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={busy || expired} onClick={() => void respond(false)}>
            <X className="size-4" aria-hidden="true" />
            Отклонить
          </Button>
          <Button disabled={busy || expired} onClick={() => void respond(true)}>
            {busy ? (
              <Timer className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="size-4" aria-hidden="true" />
            )}
            Принять
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
