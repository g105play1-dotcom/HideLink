'use client';

import type { ReportWarningResponse } from '@anonlink/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { apiRequest } from '@/lib/http';
import { describeError } from '@/lib/error-text';
import { useAppStore } from '@/store/app-store';

/**
 * The warning shown to a person a report named.
 *
 * It is deliberately not a report reader: only the fact of a complaint and the possible
 * ban are shown. The reporter, chat, reason and message snapshot stay on the owner's side.
 *
 * The socket event is a hint; the durable source is `GET /me/report-warning`. That is what
 * makes the warning survive a reload and reach somebody who was offline when the report was
 * filed. The dialog cannot be dismissed without acknowledging it, because an accidental
 * backdrop click should not silently consume a moderation warning.
 */
export function ReportWarningDialog() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const connection = useAppStore((state) => state.connection);
  const publicId = useAppStore((state) => state.session?.publicId ?? null);
  const version = useAppStore((state) => state.reportWarningVersion);

  // The identity is part of the key, not just a dependency: after "Get a new User ID" the
  // previous identity's warning must not appear for even one frame. A cache keyed only by
  // the route would keep serving the old warning until the refetch landed.
  const queryKey = ['report-warning', publicId] as const;
  const warning = useQuery({
    queryKey,
    queryFn: () => apiRequest<ReportWarningResponse>('/me/report-warning'),
    enabled: connection === 'connected' && publicId !== null,
    retry: false,
  });

  const { refetch } = warning;
  useEffect(() => {
    if (version > 0) void refetch();
  }, [version, refetch]);

  const acknowledge = useMutation({
    mutationFn: () =>
      apiRequest<{ cleared: boolean }>('/me/report-warning/read', { method: 'POST' }),
    onSuccess: () => queryClient.setQueryData(queryKey, { warning: null }),
  });

  const open = Boolean(warning.data?.warning);
  if (!open) return null;

  return (
    <Dialog
      open={open}
      dismissible={false}
      title={t('На вас поступила жалоба')}
      description={t(
        'Администрация рассмотрит её. Если будут выявлены нарушения правил, ваш доступ могут закрыть — вплоть до бана.',
      )}
    >
      <div className="flex flex-col gap-4">
        <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          {t('Жалоба уже зарегистрирована. Отвечать на неё здесь не нужно.')}
        </p>

        {acknowledge.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {describeError(acknowledge.error)}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button onClick={() => acknowledge.mutate()} disabled={acknowledge.isPending}>
            {acknowledge.isPending ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {t('Понятно')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
