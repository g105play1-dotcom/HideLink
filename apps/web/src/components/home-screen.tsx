'use client';

import { LoaderCircle, Mail, MessageSquare, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { AdSlot } from '@/components/ad-slot';
import { BlockDialog } from '@/components/block-dialog';
import { ChatPanel } from '@/components/chat-panel';
import { ConnectionBadge } from '@/components/connection-badge';
import { ContactOwnerDialog } from '@/components/contact-owner-dialog';
import { DirectSearch } from '@/components/direct-search';
import { IdentityStrip } from '@/components/identity-strip';
import { IncomingRequestDialog } from '@/components/incoming-request-dialog';
import { ReportDialog } from '@/components/report-dialog';
import { SearchPanel } from '@/components/search-panel';
import { ThemeToggle } from '@/components/theme-toggle';
import { Toaster } from '@/components/toaster';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { client } from '@/lib/anonymous-client';
import { useAppStore } from '@/store/app-store';

/**
 * The whole application screen — one page.
 *
 * It used to be three tabs (random chat, by User ID, settings), which meant the two
 * things a user can *do* were hidden behind a mode switch, and the identity card took the
 * top third of every screen. The owner asked for one page with the identity in the header
 * and the ID search directly under it (docs/DECISIONS.md D22).
 *
 * The screen is a pure function of the store's `phase`, which is why the phases are
 * modelled explicitly rather than inferred from a handful of booleans: an impossible
 * combination (searching *and* chatting) cannot be represented.
 */
export function HomeScreen() {
  const connection = useAppStore((state) => state.connection);
  const connectionDetail = useAppStore((state) => state.connectionDetail);
  const bootError = useAppStore((state) => state.bootError);
  const protocolMismatch = useAppStore((state) => state.protocolMismatch);
  const session = useAppStore((state) => state.session);
  const phase = useAppStore((state) => state.phase);
  const chat = useAppStore((state) => state.chat);

  const [reporting, setReporting] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [contacting, setContacting] = useState(false);
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
    /*
      A three-column shell: a content column flanked by two reserved advertising rails
      (docs/DECISIONS.md D23). The rails only exist on wide screens, and they are empty
      today — the point is that filling them later moves no existing element.
    */
    <div className="mx-auto flex w-full max-w-[1360px] items-stretch gap-4 px-3 sm:px-5">
      <AdRail side="left" />

      <div className="mx-auto flex min-h-dvh w-full max-w-[900px] min-w-0 flex-col gap-3 py-3 sm:py-4">
        <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-b border-border pb-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex items-center gap-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <MessageSquare className="size-4" aria-hidden="true" />
              </span>
              <h1 className="text-lg leading-none font-semibold">AnonLink</h1>
            </div>

            {session ? <IdentityStrip session={session} /> : <IdentitySkeleton />}
          </div>

          <div className="flex items-center gap-2">
            <ConnectionBadge />
            <ThemeToggle />
          </div>
        </header>

        {protocolMismatch ? (
          <Card className="border-destructive/50">
            <CardContent className="flex items-start gap-3 pt-4 sm:pt-5">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <p className="text-sm" role="alert">
                Сервер работает по другой версии протокола. Обновите страницу — иначе сообщения
                могут теряться.
              </p>
            </CardContent>
          </Card>
        ) : null}

        <main id="main" className="flex min-h-0 flex-1 flex-col gap-3">
          {!reachable && !session ? (
            <UnavailableState
              title={connection === 'rejected' ? 'Доступ закрыт' : 'Нет связи с сервером'}
              detail={connectionDetail ?? bootError ?? 'Не удалось получить анонимную сессию.'}
              onRetry={() => void retry()}
              retrying={retrying}
            />
          ) : (
            <>
              {/*
                Only while idle: joining a chat is impossible while another one is running
                (the server refuses it), and while a search is in progress the field would
                be a control that cannot be used.
              */}
              {phase === 'idle' ? <DirectSearch /> : null}

              {inChat && chat ? (
                <ChatPanel
                  chat={chat}
                  // The block action is the administration's decision, not the user's: with
                  // the platform policy off, the button is not offered at all (D31). While
                  // the session is still loading there is no chat either, so `false` is the
                  // safe default and matches what the server would answer.
                  canBlock={session?.blockingEnabled ?? false}
                  onReport={() => setReporting(true)}
                  onBlock={() => setBlocking(true)}
                />
              ) : (
                <SearchPanel session={session} />
              )}
            </>
          )}
        </main>

        {/*
          The one way to reach a human. It lives in the footer rather than in the settings
          drawer on purpose: "связаться с администрацией" is not a preference, and someone who is
          annoyed with the service should not have to open their own profile to say so.
        */}
        <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
          <span>Анонимный чат с незнакомцами</span>
          <button
            type="button"
            onClick={() => setContacting(true)}
            className="inline-flex items-center gap-1.5 font-medium text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
          >
            <Mail className="size-3.5" aria-hidden="true" />
            Связаться с администрацией
          </button>
        </footer>
      </div>

      <AdRail side="right" />

      <IncomingRequestDialog />
      <ReportDialog open={reporting} onClose={() => setReporting(false)} />
      <BlockDialog open={blocking} onClose={() => setBlocking(false)} />
      <ContactOwnerDialog open={contacting} onClose={() => setContacting(false)} />
      <Toaster />
    </div>
  );
}

/** One reserved advertising column. Empty by construction; see `AdSlot`. */
function AdRail({ side }: { side: 'left' | 'right' }) {
  return (
    <aside aria-hidden="true" className="hidden w-[170px] shrink-0 xl:block" data-ad-rail={side}>
      <AdSlot variant="rail" />
    </aside>
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

function IdentitySkeleton() {
  return (
    <div className="flex flex-col gap-1" aria-busy="true" aria-label="Получаем ваш User ID">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-7 w-44" />
    </div>
  );
}
