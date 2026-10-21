'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Ban, LoaderCircle } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { client } from '@/lib/anonymous-client';

/**
 * Confirm blocking the current peer.
 *
 * Blocking is the one action here that outlives the conversation: it is stored against
 * the identity, it ends the chat immediately, and lifting it later means finding the
 * person in the block list at the bottom of the main page. That is worth one confirmation.
 *
 * Leaving an abusive chat stays a single click ("Завершить"): the safety-critical action
 * must not be slowed down, but the durable one can be.
 */
export function BlockDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      const outcome = await client.blockCurrentPeer();
      if (outcome.ok) {
        onClose();
        // The idle screen keeps the block list mounted, and its query counts as fresh
        // for ten seconds. Without this the person would return from the chat and see a
        // list that does not contain the block they just made. A block also severs a
        // friendship server-side, so the friend list has to be refreshed with it.
        void queryClient.invalidateQueries({ queryKey: ['blocks'] });
        void queryClient.invalidateQueries({ queryKey: ['friends'] });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={t('Заблокировать собеседника?')}
      description={t(
        'Чат завершится сразу. Вы больше не будете попадаться друг другу при случайном поиске, и этот собеседник не сможет написать вам по User ID.',
      )}
      onClose={busy ? undefined : onClose}
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-muted-foreground">
          {t(
            'Случайные собеседники не видят ваш User ID, но блокировка всё равно их запоминает — на случай, если вы встретитесь снова. Список блокировок можно посмотреть внизу главной страницы.',
          )}
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('Отмена')}
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Ban className="size-4" aria-hidden="true" />
            )}
            {t('Заблокировать')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
