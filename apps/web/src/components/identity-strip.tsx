'use client';

import { formatPublicIdForDisplay } from '@anonlink/shared';
import { Check, Copy, RefreshCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { client } from '@/lib/anonymous-client';
import { cn } from '@/lib/utils';
import { useAppStore, type SessionInfo } from '@/store/app-store';

/**
 * The user's own identity, reduced to one compact block in the header.
 *
 * It used to be a full card with a heading, a paragraph about the security model and a
 * separate copy button. The owner asked for it to be small and placed right of the
 * product name, with the copy action on the ID itself (docs/DECISIONS.md D22): the ID is
 * what the user actually needs to hand out, and everything else was a sentence nobody
 * reads twice.
 *
 * ## Why the warning line went away, and what replaced it
 *
 * "This is not a password" is the one thing that must not be lost, because "anonymous
 * chat" invites the assumption that the ID is a secret. It is still said, in the
 * settings, where the consequences live — and the copy hint next to the heading states
 * what the ID is *for* (showing it to someone) rather than what it is not.
 */
export function IdentityStrip({ session }: { session: SessionInfo }) {
  const [copied, setCopied] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const [rotating, setRotating] = useState(false);

  async function copyId() {
    try {
      await navigator.clipboard.writeText(session.publicId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access needs a secure context and an explicit permission. If the
      // browser refuses, say so rather than pretending it worked.
      useAppStore
        .getState()
        .notify('info', 'Браузер не разрешил копирование. Выделите ID и скопируйте вручную.');
    }
  }

  async function rotate() {
    setRotating(true);
    const outcome = await client.rotateIdentity();
    setRotating(false);
    if (outcome.ok) setConfirmingRotate(false);
  }

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-baseline gap-2">
        <span className="section-label">Ваш User ID</span>
        <span
          className={cn(
            'flex items-center gap-1 text-[11px]',
            copied ? 'text-success' : 'text-muted-foreground',
          )}
        >
          {copied ? (
            <>
              <Check className="size-3" aria-hidden="true" />
              Скопировано
            </>
          ) : (
            'Нажмите на него, чтобы скопировать'
          )}
        </span>
      </div>

      <div className="flex items-center gap-1">
        {/*
          The ID itself is the copy button: one target instead of a value and a control
          that does the same thing. `#own-user-id` is the end-to-end suite's hook and must
          keep containing *only* the ID — the confirmation above is outside it, or its text
          would no longer look like a User ID.
        */}
        <button
          type="button"
          id="own-user-id"
          translate="no"
          onClick={() => void copyId()}
          title="Скопировать User ID"
          className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2 py-1 font-mono text-sm tracking-wider transition-colors select-all hover:border-primary hover:bg-accent/40"
        >
          {formatPublicIdForDisplay(session.publicId)}
          <Copy className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => setConfirmingRotate(true)}
          aria-label="Получить новый User ID"
          title="Получить новый User ID"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      <Dialog
        open={confirmingRotate}
        title="Получить новый User ID?"
        description="Текущий ID перестанет работать сразу же, и все ваши открытые сессии будут закрыты. Прошлый ID восстановить нельзя."
        onClose={() => setConfirmingRotate(false)}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Ваш User ID — не пароль: по нему можно только предложить вам чат, если заявки разрешены.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmingRotate(false)}
              disabled={rotating}
            >
              Отмена
            </Button>
            <Button variant="destructive" onClick={() => void rotate()} disabled={rotating}>
              {rotating ? 'Меняем…' : 'Да, получить новый'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
