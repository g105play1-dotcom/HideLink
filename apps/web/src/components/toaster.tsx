'use client';

import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useAppStore, type Notice } from '@/store/app-store';

const AUTO_DISMISS_MS = 7_000;

const STYLES: Record<Notice['tone'], string> = {
  info: 'border-border bg-card',
  success: 'border-success/40 bg-card',
  error: 'border-destructive/50 bg-card',
};

const ICONS = { info: Info, success: CircleCheck, error: CircleAlert } as const;

/**
 * Transient feedback.
 *
 * Server errors and one-off confirmations appear here rather than as blocking
 * modals, so a failed action never traps the user behind a dialog. Each notice is a
 * `role="status"` region so a screen reader announces it on appearance.
 */
export function Toaster() {
  const { t } = useI18n();
  const notices = useAppStore((state) => state.notices);
  const dismiss = useAppStore((state) => state.dismissNotice);

  useEffect(() => {
    if (notices.length === 0) return;

    const timers = notices.map((notice) => setTimeout(() => dismiss(notice.id), AUTO_DISMISS_MS));

    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [notices, dismiss]);

  if (notices.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col gap-2 sm:inset-x-auto sm:top-4 sm:right-4 sm:bottom-auto sm:w-84"
      role="status"
      aria-live="polite"
    >
      {notices.map((notice) => {
        const Icon = ICONS[notice.tone];

        return (
          <div
            key={notice.id}
            className={cn(
              'pointer-events-auto flex items-start gap-3 rounded-card border p-3 shadow-lg',
              STYLES[notice.tone],
            )}
          >
            <Icon
              className={cn(
                'mt-0.5 size-4 shrink-0',
                notice.tone === 'error'
                  ? 'text-destructive'
                  : notice.tone === 'success'
                    ? 'text-success'
                    : 'text-muted-foreground',
              )}
              aria-hidden="true"
            />
            <p className="flex-1 text-sm">{notice.text}</p>
            <Button
              variant="ghost"
              size="icon"
              className="-mt-1 -mr-1 size-7"
              aria-label={t('Закрыть уведомление')}
              onClick={() => dismiss(notice.id)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
