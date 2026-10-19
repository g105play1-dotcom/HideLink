'use client';

import { formatPublicIdForDisplay } from '@anonlink/shared';
import { Check, Copy, RefreshCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { client } from '@/lib/anonymous-client';
import { formatDateTime } from '@/lib/format';
import { useAppStore, type SessionInfo } from '@/store/app-store';

/**
 * The user's own identity.
 *
 * The User ID is public by design — it is how someone else can start a chat with
 * them — which is why it is shown in full, with a copy button, and stated plainly as
 * non-secret. The security model is explained in the same breath, because "anonymous
 * chat" invites the assumption that this string is a password.
 */
export function IdentityCard({ session }: { session: SessionInfo }) {
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
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
          Ваш User ID
        </CardTitle>
        <CardDescription>
          Это ваш публичный идентификатор. Он не является паролем — по нему можно только предложить
          вам чат, если вы разрешили заявки.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <code
            id="own-user-id"
            className="rounded-lg border border-border bg-muted px-3 py-2 font-mono text-sm tracking-wider select-all"
          >
            {formatPublicIdForDisplay(session.publicId)}
          </code>

          <Button variant="outline" size="sm" onClick={() => void copyId()}>
            {copied ? (
              <>
                <Check className="size-4 text-success" aria-hidden="true" />
                Скопировано
              </>
            ) : (
              <>
                <Copy className="size-4" aria-hidden="true" />
                Копировать
              </>
            )}
          </Button>

          <Button variant="ghost" size="sm" onClick={() => setConfirmingRotate(true)}>
            <RefreshCw className="size-4" aria-hidden="true" />
            Новый ID
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">Создан {formatDateTime(session.createdAt)}</p>
      </CardContent>

      <Dialog
        open={confirmingRotate}
        title="Получить новый User ID?"
        description="Текущий ID перестанет работать сразу же, и все ваши открытые сессии будут закрыты. Прошлый ID восстановить нельзя."
        onClose={() => setConfirmingRotate(false)}
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmingRotate(false)} disabled={rotating}>
            Отмена
          </Button>
          <Button variant="destructive" onClick={() => void rotate()} disabled={rotating}>
            {rotating ? 'Меняем…' : 'Да, получить новый'}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
