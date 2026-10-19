'use client';

import { REPORT_REASONS, type ReportReason } from '@anonlink/shared';
import { Flag, LoaderCircle } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { client } from '@/lib/anonymous-client';
import { REPORT_REASON_LABELS } from '@/lib/error-text';
import { cn } from '@/lib/utils';

/**
 * Report the current chat.
 *
 * A report ends the conversation server-side, and it is the only place a message's
 * text is ever written to the database — as a snapshot the *server* takes from its own
 * copy, so the reporter cannot forge what they are reporting. The dialog says so, so
 * the consequence is not a surprise.
 */
export function ReportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [reason, setReason] = useState<ReportReason>('abuse');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const outcome = await client.reportCurrentChat(reason, details.trim() || undefined);
      if (outcome.ok) {
        setDetails('');
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="Пожаловаться на собеседника"
      description="Чат будет сразу завершён. Ваш User ID не сообщается собеседнику."
      onClose={busy ? undefined : onClose}
    >
      <div className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Причина</legend>

          {REPORT_REASONS.map((value) => (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 text-sm transition-colors',
                reason === value ? 'border-primary bg-accent/50' : 'border-border hover:bg-muted',
              )}
            >
              <input
                type="radio"
                name="report-reason"
                value={value}
                checked={reason === value}
                onChange={() => setReason(value)}
                className="accent-(--primary)"
              />
              {REPORT_REASON_LABELS[value]}
            </label>
          ))}
        </fieldset>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium" htmlFor="report-details">
            Подробности <span className="font-normal text-muted-foreground">(необязательно)</span>
          </label>
          <Textarea
            id="report-details"
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Что именно произошло?"
          />
          <p className="text-xs text-muted-foreground">
            Вместе с жалобой сохраняется текст последнего сообщения — это то, что проверяет
            модерация. Всё остальное не сохраняется.
          </p>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="destructive" onClick={() => void submit()} disabled={busy}>
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Flag className="size-4" aria-hidden="true" />
            )}
            Отправить жалобу
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
