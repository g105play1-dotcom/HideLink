'use client';

import {
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Search,
  Settings,
  TriangleAlert,
  UserSearch,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { BlockDialog } from '@/components/block-dialog';
import { ChatPanel } from '@/components/chat-panel';
import { ConnectionBadge } from '@/components/connection-badge';
import { DirectPanel } from '@/components/direct-panel';
import { IdentityCard } from '@/components/identity-card';
import { IncomingRequestDialog } from '@/components/incoming-request-dialog';
import { PreferencesPanel } from '@/components/preferences-panel';
import { ReportDialog } from '@/components/report-dialog';
import { SearchPanel } from '@/components/search-panel';
import { Toaster } from '@/components/toaster';
import { client } from '@/lib/anonymous-client';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';

type Tab = 'search' | 'direct' | 'settings';

const TABS: Array<{ id: Tab; label: string; icon: typeof Search }> = [
  { id: 'search', label: 'Случайный чат', icon: Search },
  { id: 'direct', label: 'По User ID', icon: UserSearch },
  { id: 'settings', label: 'Настройки', icon: Settings },
];

/**
 * The whole application screen.
 *
 * It is a pure function of the store's `phase`, which is why the phases are modelled
 * explicitly on the store rather than inferred from a handful of booleans: an
 * impossible combination (searching *and* chatting) cannot be represented.
 */
export function HomeScreen() {
  const connection = useAppStore((state) => state.connection);
  const connectionDetail = useAppStore((state) => state.connectionDetail);
  const bootError = useAppStore((state) => state.bootError);
  const protocolMismatch = useAppStore((state) => state.protocolMismatch);
  const session = useAppStore((state) => state.session);
  const phase = useAppStore((state) => state.phase);
  const chat = useAppStore((state) => state.chat);

  const [tab, setTab] = useState<Tab>('search');
  const [reporting, setReporting] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const inChat = phase === 'chatting' || phase === 'ended';
  const reachable =
    connection === 'connected' || connection === 'connecting' || connection === 'reconnecting';

  async function retry() {
    setRetrying(true);
    try {
      await client.retryBoot();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <MessageSquare className="size-5" aria-hidden="true" />
          </span>
          <div className="flex flex-col">
            <h1 className="text-lg leading-tight font-semibold">AnonLink</h1>
            <p className="text-xs text-muted-foreground">Анонимный чат без регистрации</p>
          </div>
        </div>

        <ConnectionBadge />
      </header>

      {protocolMismatch ? (
        <Card className="border-destructive/50">
          <CardContent className="flex items-start gap-3 pt-4 sm:pt-5">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <p className="text-sm" role="alert">
              Сервер работает по другой версии протокола. Обновите страницу — иначе сообщения могут
              теряться.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <main id="main" className="flex min-h-0 flex-1 flex-col gap-4">
        {!reachable && !session ? (
          <UnavailableState
            title={connection === 'rejected' ? 'Доступ закрыт' : 'Нет связи с сервером'}
            detail={connectionDetail ?? bootError ?? 'Не удалось получить анонимную сессию.'}
            onRetry={() => void retry()}
            retrying={retrying}
          />
        ) : (
          <>
            {session ? <IdentityCard session={session} /> : <IdentityCardSkeleton />}

            {inChat && chat ? (
              <ChatPanel
                chat={chat}
                onReport={() => setReporting(true)}
                onBlock={() => setBlocking(true)}
              />
            ) : phase === 'searching' ? (
              <SearchPanel />
            ) : (
              <div className="flex flex-col gap-4">
                <div
                  className="flex flex-wrap gap-1 rounded-card border border-border bg-muted/50 p-1"
                  role="tablist"
                  aria-label="Разделы"
                >
                  {TABS.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      id={`tab-${id}`}
                      aria-selected={tab === id}
                      aria-controls={`panel-${id}`}
                      onClick={() => setTab(id)}
                      className={cn(
                        'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                        tab === id
                          ? 'bg-card shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="size-4" aria-hidden="true" />
                      {label}
                    </button>
                  ))}
                </div>

                <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
                  {tab === 'search' ? (
                    <SearchPanel onOpenSettings={() => setTab('settings')} />
                  ) : null}
                  {tab === 'direct' ? <DirectPanel /> : null}
                  {tab === 'settings' && session ? <PreferencesPanel session={session} /> : null}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      <IncomingRequestDialog />
      <ReportDialog open={reporting} onClose={() => setReporting(false)} />
      <BlockDialog open={blocking} onClose={() => setBlocking(false)} />
      <Toaster />
    </div>
  );
}

function UnavailableState({
  title,
  detail,
  onRetry,
  retrying,
}: {
  title: string;
  detail: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <Card className="flex flex-1 flex-col justify-center">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-destructive" aria-hidden="true" />
          {title}
        </CardTitle>
        <CardDescription>{detail}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button onClick={onRetry} disabled={retrying} className="w-full sm:w-auto">
          {retrying ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="size-4" aria-hidden="true" />
          )}
          Повторить
        </Button>

        <p className="text-xs text-muted-foreground">
          Если не помогает: проверьте, что API-сервер запущен, и что браузер не блокирует cookie для
          этого сайта — без cookie анонимная сессия невозможна.
        </p>
      </CardContent>
    </Card>
  );
}

function IdentityCardSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Получаем ваш User ID">
      <CardHeader className="pb-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="mt-2 h-4 w-full max-w-md" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-3 w-32" />
      </CardContent>
    </Card>
  );
}
