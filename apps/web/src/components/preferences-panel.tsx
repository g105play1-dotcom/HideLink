'use client';

import type { BlockListResponse, IncomingRequestPolicy, SessionView } from '@anonlink/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CircleAlert, LoaderCircle, Settings, ShieldCheck } from 'lucide-react';

import { SearchPreferencesPanel } from '@/components/search-preferences-panel';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { client } from '@/lib/anonymous-client';
import { describeError } from '@/lib/error-text';
import { apiRequest } from '@/lib/http';
import { cn } from '@/lib/utils';
import type { SessionInfo } from '@/store/app-store';

const POLICY_OPTIONS: Array<{ value: IncomingRequestPolicy; label: string; hint: string }> = [
  {
    value: 'everyone',
    label: 'Принимать заявки',
    hint: 'Любой, кто знает ваш User ID, может предложить чат.',
  },
  {
    value: 'nobody',
    label: 'Не принимать заявки',
    hint: 'Вас можно найти, но предложить чат нельзя. Случайный поиск работает как обычно.',
  },
];

/**
 * Preferences and the block list.
 *
 * Both write through to the server and reflect the *server's* answer, so the UI can
 * never claim a setting was saved when it was not.
 */
export function PreferencesPanel({ session }: { session: SessionInfo }) {
  const queryClient = useQueryClient();

  const updateSetting = useMutation({
    mutationFn: (incomingRequests: IncomingRequestPolicy) =>
      apiRequest<SessionView>('/me/settings', { method: 'PATCH', json: { incomingRequests } }),
    onSuccess: (updated) => {
      // The response nests everything under `settings`. Reading the field flat
      // (`updated.incomingRequests`) left the toggle showing the *old* value until the page
      // was reloaded: the setting was saved, but the screen said otherwise.
      client.applySession(updated);
    },
  });

  const blocks = useQuery({
    queryKey: ['blocks'],
    queryFn: () => apiRequest<BlockListResponse>('/blocks'),
    staleTime: 10_000,
  });

  const unblock = useMutation({
    mutationFn: (publicId: string) =>
      apiRequest<{ removed: boolean }>(`/blocks/${publicId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['blocks'] });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <SearchPreferencesPanel session={session} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="size-4 text-primary" aria-hidden="true" />
            Входящие заявки
          </CardTitle>
          <CardDescription>
            Управляет только заявками по User ID. Случайный собеседник может написать вам всегда.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-2">
          {POLICY_OPTIONS.map((option) => {
            const selected = session.incomingRequests === option.value;

            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                disabled={updateSetting.isPending}
                onClick={() => updateSetting.mutate(option.value)}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition-colors disabled:opacity-60',
                  selected ? 'border-primary bg-accent/50' : 'border-border hover:bg-muted',
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {selected ? (
                    <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
                  ) : null}
                  {option.label}
                </span>
                <span className="text-xs text-muted-foreground">{option.hint}</span>
              </button>
            );
          })}

          {updateSetting.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {describeError(updateSetting.error)}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Ban className="size-4 text-primary" aria-hidden="true" />
            Заблокированные
          </CardTitle>
          <CardDescription>
            Блокировка действует в обе стороны: вы больше не сможете случайно попасть к этому
            человеку, а он — к вам.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          {blocks.isPending ? (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Загрузка списка">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          ) : null}

          {blocks.isError ? (
            <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
              <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
              {describeError(blocks.error)}
            </p>
          ) : null}

          {blocks.isSuccess && blocks.data.blocks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Список пуст.</p>
          ) : null}

          {blocks.data?.blocks.map((block) => (
            <div
              key={block.publicId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
            >
              <code className="font-mono text-sm">{block.publicId}</code>
              <Button
                variant="outline"
                size="sm"
                disabled={unblock.isPending}
                onClick={() => unblock.mutate(block.publicId)}
              >
                {unblock.isPending && unblock.variables === block.publicId ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                Разблокировать
              </Button>
            </div>
          ))}

          {unblock.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {describeError(unblock.error)}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
