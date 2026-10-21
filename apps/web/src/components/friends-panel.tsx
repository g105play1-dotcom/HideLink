'use client';

import {
  formatPublicIdForDisplay,
  type FriendListResponse,
  type FriendView,
} from '@anonlink/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Send,
  UserMinus,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { client } from '@/lib/anonymous-client';
import { describeError } from '@/lib/error-text';
import { formatDateTime } from '@/lib/format';
import { apiRequest } from '@/lib/http';
import { useAppStore } from '@/store/app-store';

/**
 * The caller's own friend list.
 *
 * A friendship is persistent but deliberately minimal: the other person's User ID and
 * the date both sides agreed. There is no nickname, presence or message history here,
 * because none of that exists server-side either (docs/DECISIONS.md D34).
 *
 * Removing a contact is one-sided and immediate. The other side is told over the socket
 * so their open tab cannot keep showing a button that will only fail.
 */
export function FriendsPanel() {
  const { locale, t } = useI18n();
  const friendsVersion = useAppStore((state) => state.friendsVersion);
  const bumpFriendsVersion = useAppStore((state) => state.bumpFriendsVersion);
  const outgoingRequest = useAppStore((state) => state.outgoingRequest);
  const notify = useAppStore((state) => state.notify);

  const [removing, setRemoving] = useState<FriendView | null>(null);

  const friends = useQuery({
    queryKey: ['friends', friendsVersion],
    queryFn: () => apiRequest<FriendListResponse>('/friends'),
    staleTime: 10_000,
  });

  const send = useMutation({
    mutationFn: (publicId: string) => client.requestDirect(publicId),
    onSuccess: (outcome) => {
      if (outcome.ok) {
        notify('success', t('Заявка отправлена. Ждём ответа.'));
      }
    },
  });

  const remove = useMutation({
    mutationFn: (publicId: string) =>
      apiRequest<{ removed: boolean }>(`/friends/${encodeURIComponent(publicId)}`, {
        method: 'DELETE',
      }),
    onSuccess: (result) => {
      setRemoving(null);
      bumpFriendsVersion();
      if (result.removed) notify('success', t('Контакт удалён из списка друзей.'));
    },
    onError: (error) => {
      notify('error', describeError(error, locale));
    },
  });

  const list = friends.data?.friends ?? [];

  return (
    <Card aria-busy={friends.isFetching}>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle id="friends-heading" className="flex items-center gap-2">
            <UsersRound className="size-4 text-primary" aria-hidden="true" />
            {t('Друзья')}
            {friends.isSuccess ? <Badge>{list.length}</Badge> : null}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('Друзья сохраняются, пока вы сами не удалите контакт.')}
          </p>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => void friends.refetch()}
          disabled={friends.isFetching}
          aria-label={t('Обновить список друзей')}
        >
          <RefreshCw
            className={friends.isFetching ? 'size-4 animate-spin' : 'size-4'}
            aria-hidden="true"
          />
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {friends.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            {t('Загружаем друзей…')}
          </p>
        ) : null}

        {friends.isError ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
            {describeError(friends.error, locale)}
          </p>
        ) : null}

        {friends.isSuccess && list.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t(
              'У вас пока нет друзей. Добавить в друзья можно во время чата — по обоюдному согласию.',
            )}
          </p>
        ) : null}

        {list.length > 0 ? (
          <ul className="flex flex-col gap-2" aria-label={t('Список друзей')}>
            {list.map((friend) => (
              <li
                key={friend.publicId}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-2"
              >
                <UserRound className="size-4 shrink-0 text-primary" aria-hidden="true" />

                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <code
                    translate="no"
                    className="truncate font-mono text-sm text-foreground"
                    title={friend.publicId}
                  >
                    {formatPublicIdForDisplay(friend.publicId)}
                  </code>
                  <span className="text-xs text-muted-foreground">
                    {t('Добавлен: {date}', {
                      date: formatDateTime(friend.since, locale),
                    })}
                  </span>
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => send.mutate(friend.publicId)}
                  disabled={send.isPending || outgoingRequest !== null}
                >
                  {send.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="size-4" aria-hidden="true" />
                  )}
                  <span className="sr-only sm:not-sr-only">{t('Написать')}</span>
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRemoving(friend)}
                  aria-label={t('Удалить {id} из друзей', { id: friend.publicId })}
                >
                  <UserMinus className="size-4" aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">{t('Удалить')}</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>

      <Dialog
        open={removing !== null}
        title={t('Удалить контакт?')}
        description={t(
          'Вы больше не увидите этот User ID в списке друзей. Если вы снова встретитесь в чате, сможете добавить друг друга заново.',
        )}
        onClose={() => setRemoving(null)}
      >
        {removing ? (
          <div className="flex flex-col gap-3">
            <code
              translate="no"
              className="w-fit rounded border border-border bg-muted px-2 py-1 font-mono text-sm"
            >
              {formatPublicIdForDisplay(removing.publicId)}
            </code>

            {remove.isError ? (
              <p className="text-sm text-destructive" role="alert">
                {describeError(remove.error, locale)}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRemoving(null)} disabled={remove.isPending}>
                {t('Отмена')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => remove.mutate(removing.publicId)}
                disabled={remove.isPending}
              >
                {remove.isPending ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <UserMinus className="size-4" aria-hidden="true" />
                )}
                {t('Удалить')}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </Card>
  );
}
