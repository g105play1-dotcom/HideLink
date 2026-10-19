'use client';

import { Ban, LoaderCircle } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { client } from '@/lib/anonymous-client';

/**
 * Confirm blocking the current peer.
 *
 * Blocking is the one action here that outlives the conversation: it is stored against
 * the identity, it ends the chat immediately, and for a *random* match there is no way
 * back — the peer's User ID was never shown, so the block could not be undone later even
 * if the user wanted to. That is worth one confirmation.
 *
 * Leaving an abusive chat stays a single click ("Завершить"): the safety-critical action
 * must not be slowed down, but the durable one can be.
 */
export function BlockDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      const outcome = await client.blockCurrentPeer();
      if (outcome.ok) onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="Заблокировать собеседника?"
      description="Чат завершится сразу. Вы больше не будете попадаться друг другу при случайном поиске, и этот собеседник не сможет написать вам по User ID."
      onClose={busy ? undefined : onClose}
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-muted-foreground">
          Случайные собеседники не видят ваш User ID, но блокировка всё равно их запоминает — на
          случай, если вы встретитесь снова. Список блокировок можно посмотреть в разделе
          «Настройки».
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Ban className="size-4" aria-hidden="true" />
            )}
            Заблокировать
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
