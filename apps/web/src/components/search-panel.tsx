'use client';

import { LoaderCircle, Search, SlidersHorizontal, Users } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { client } from '@/lib/anonymous-client';
import { formatElapsed, formatRemaining } from '@/lib/format';
import { CRITERION_LABELS, describeCriteria } from '@/lib/labels';
import { useTicker } from '@/lib/use-ticker';
import { useAppStore } from '@/store/app-store';

/**
 * Random matching.
 *
 * Two states, both real: a call to action when idle, and a live waiting screen while
 * queued. The waiting screen shows an elapsed timer because "how long have I been
 * waiting" is the one thing a user wants to know, and it proves the request is still
 * alive rather than silently dropped.
 *
 * Both states also state *which filters are being applied*, and they read them from
 * different places on purpose: while idle, from the saved settings (what a search would
 * use); while waiting, from the server (what is actually being used, including anything it
 * has already dropped). Showing the form's values while waiting would be a lie the moment
 * the server widened the search.
 */
export function SearchPanel({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const phase = useAppStore((state) => state.phase);
  const searchingSince = useAppStore((state) => state.searchingSince);
  const searchCriteria = useAppStore((state) => state.searchCriteria);
  const relaxAfterMs = useAppStore((state) => state.relaxAfterMs);
  const relaxedCriteria = useAppStore((state) => state.relaxedCriteria);
  const savedSearch = useAppStore((state) => state.session?.search ?? null);
  const [pending, setPending] = useState(false);

  const searching = phase === 'searching';
  // Ticks only while the waiting screen is visible.
  const now = useTicker(searching);

  async function start() {
    setPending(true);
    await client.startMatching();
    setPending(false);
  }

  async function cancel() {
    setPending(true);
    await client.cancelMatching();
    setPending(false);
  }

  if (searching) {
    const active = searchCriteria ? describeCriteria(searchCriteria) : [];
    // `relaxAfterMs` is measured from the moment the search started, and the start time is
    // the server's own `queuedAt`, so the deadline is exact rather than approximate.
    const relaxAt =
      relaxAfterMs !== null && searchingSince
        ? new Date(new Date(searchingSince).getTime() + relaxAfterMs).toISOString()
        : null;

    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden="true" />
            Ищем собеседника…
          </CardTitle>
          <CardDescription>
            Как только кто-то освободится, чат откроется автоматически. Можно не ждать здесь — поиск
            продолжится.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-2xl tabular-nums" aria-label="Время ожидания">
              {searchingSince ? formatElapsed(searchingSince, now) : '00:00'}
            </span>
            <Button variant="outline" onClick={() => void cancel()} disabled={pending}>
              Отменить поиск
            </Button>
          </div>

          <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
            <p className="text-xs font-medium text-muted-foreground">Ищем по фильтрам</p>

            {active.length === 0 ? (
              <p className="text-sm">Без фильтров — подойдёт любой собеседник.</p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-sm">
                {active.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}

            {relaxedCriteria.length > 0 ? (
              <p className="text-sm text-muted-foreground" role="status">
                Уже снято:{' '}
                {relaxedCriteria.map((criterion) => CRITERION_LABELS[criterion]).join(', ')}
              </p>
            ) : null}

            {relaxAt ? (
              <p className="text-xs text-muted-foreground">
                Если никто не найдётся, через {formatRemaining(relaxAt, now)} сервер начнёт снимать
                фильтры по одному и каждый раз сообщит, какой именно.
              </p>
            ) : null}
          </div>

          <p className="text-xs text-muted-foreground">
            Фильтры можно изменить в «Настройках» после отмены поиска.
          </p>
        </CardContent>
      </Card>
    );
  }

  const saved = savedSearch ? describeCriteria(savedSearch) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4 text-primary" aria-hidden="true" />
          Случайный собеседник
        </CardTitle>
        <CardDescription>
          Анонимный чат один на один. Ни вы, ни собеседник не видите User ID друг друга — только
          вымышленное имя на время разговора.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Button
          size="lg"
          onClick={() => void start()}
          disabled={pending}
          className="w-full sm:w-auto"
        >
          {pending ? (
            <>
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Начинаем…
            </>
          ) : (
            <>
              <Search className="size-4" aria-hidden="true" />
              Найти собеседника
            </>
          )}
        </Button>

        {savedSearch ? (
          <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <SlidersHorizontal className="size-3.5" aria-hidden="true" />
                Фильтры поиска
              </p>
              {onOpenSettings ? (
                <Button variant="ghost" size="sm" onClick={onOpenSettings}>
                  Изменить
                </Button>
              ) : null}
            </div>

            {saved.length === 0 ? (
              <p className="text-sm">Без фильтров — подойдёт любой собеседник.</p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-sm">
                {saved.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <li>• Переписка хранится только в памяти и не сохраняется после завершения чата.</li>
          <li>• Можно завершить чат в любой момент или сразу перейти к следующему.</li>
          <li>• Собеседника можно заблокировать или отправить на него жалобу.</li>
        </ul>
      </CardContent>
    </Card>
  );
}
