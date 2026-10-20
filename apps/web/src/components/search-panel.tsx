'use client';

import { LoaderCircle, Search, Settings2 } from 'lucide-react';
import { useState } from 'react';

import { AdSlot } from '@/components/ad-slot';
import { SettingsPanel, SettingsSkeleton } from '@/components/settings-panel';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { client } from '@/lib/anonymous-client';
import { formatElapsed, formatRemaining } from '@/lib/format';
import { CRITERION_LABELS, describeCriteria } from '@/lib/labels';
import { useTicker } from '@/lib/use-ticker';
import { useAppStore, type SessionInfo } from '@/store/app-store';

/**
 * Random matching, and the settings that shape it — one page, no tabs.
 *
 * ## Why the settings are a disclosure under the button
 *
 * The owner asked for exactly that (docs/DECISIONS.md D22). It also happens to be the
 * right shape: the call to action is the one thing a returning user wants, the filters
 * are something you set once and then rarely revisit, and a filter you cannot see is a
 * filter you will blame the search for. So the collapsed state still *states* what is
 * applied and offers one button to change it.
 *
 * ## Two states, two sources for the filters
 *
 * The waiting screen reports the criteria the *server* says it is applying, not the ones
 * the form holds: the moment the server widens the search the form is out of date, and
 * telling the user the wrong criteria would be worse than telling them nothing. The
 * elapsed timer is there because "how long have I been waiting" is the one thing a waiting
 * user wants to know, and it proves the request is still alive.
 */
export function SearchPanel({ session }: { session: SessionInfo | null }) {
  const phase = useAppStore((state) => state.phase);
  const searchingSince = useAppStore((state) => state.searchingSince);
  const searchCriteria = useAppStore((state) => state.searchCriteria);
  const relaxAfterMs = useAppStore((state) => state.relaxAfterMs);
  const relaxedCriteria = useAppStore((state) => state.relaxedCriteria);
  const savedSearch = useAppStore((state) => state.session?.search ?? null);

  const [pending, setPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden="true" />
              Ищем собеседника…
            </span>
            <span className="font-mono text-xl tabular-nums" aria-label="Время ожидания">
              {searchingSince ? formatElapsed(searchingSince, now) : '00:00'}
            </span>
            <Button variant="outline" size="sm" onClick={() => void cancel()} disabled={pending}>
              Отменить поиск
            </Button>
          </div>

          <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
            <p className="section-label">Ищем по фильтрам</p>

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
            Можно не ждать здесь — поиск продолжится, а чат откроется автоматически.
          </p>
        </CardContent>
      </Card>
    );
  }

  const saved = savedSearch ? describeCriteria(savedSearch) : [];

  return (
    <div className="flex flex-1 flex-col gap-3">
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <Button size="lg" onClick={() => void start()} disabled={pending} className="w-full">
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

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="section-label">Фильтры поиска</span>
              <span className="truncate text-sm">
                {saved.length === 0
                  ? 'Без фильтров — подойдёт любой собеседник.'
                  : saved.join(' · ')}
              </span>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
              aria-controls="settings-panel"
            >
              <Settings2 className="size-4" aria-hidden="true" />
              Настройки
            </Button>
          </div>
        </CardContent>
      </Card>

      {settingsOpen ? (
        <div id="settings-panel">
          {session ? <SettingsPanel session={session} /> : <SettingsSkeleton />}
        </div>
      ) : (
        /*
          Folding the settings leaves the largest empty area on the page, and the owner
          asked for it to be given to advertising (docs/DECISIONS.md D28). So it is a
          real, sized container that takes exactly the space the settings would have
          filled — a creative added later changes the content, not the layout. While
          there is nothing to show it paints nothing, like the side rails (D23).
        */
        <aside aria-hidden="true" data-ad-slot="under-settings" className="flex min-h-40 flex-1">
          <AdSlot variant="banner" />
        </aside>
      )}
    </div>
  );
}
