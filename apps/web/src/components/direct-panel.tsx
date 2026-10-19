'use client';

import {
  isValidPublicId,
  normalizePublicId,
  formatPublicIdForDisplay,
  type UserLookupView,
} from '@anonlink/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  Search,
  Send,
  Timer,
  UserSearch,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { client } from '@/lib/anonymous-client';
import { describeError } from '@/lib/error-text';
import { formatRemaining } from '@/lib/format';
import { apiRequest } from '@/lib/http';
import { useTicker } from '@/lib/use-ticker';
import { useAppStore } from '@/store/app-store';

/**
 * Direct contact by User ID.
 *
 * The flow is deliberately two steps — look up, then send — because the first step is
 * the one that can fail for a reason the user can act on (the ID does not exist, or
 * the person disabled requests). Sending blind would leave them guessing.
 *
 * Validation uses the *shared* schema, so the browser rejects a malformed ID before
 * spending a request on it, and the server applies exactly the same rule.
 */
export function DirectPanel() {
  const ownPublicId = useAppStore((state) => state.session?.publicId ?? null);
  const outgoingRequest = useAppStore((state) => state.outgoingRequest);

  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const normalized = submitted ? normalizePublicId(submitted) : '';
  const formatValid = submitted !== null && isValidPublicId(normalized);
  const isSelf = formatValid && ownPublicId !== null && normalized === ownPublicId;

  const lookup = useQuery({
    queryKey: ['user-lookup', normalized],
    queryFn: () => apiRequest<UserLookupView>(`/users/${normalized}`),
    enabled: formatValid && !isSelf,
    retry: false,
    staleTime: 30_000,
  });

  const send = useMutation({
    mutationFn: (publicId: string) => client.requestDirect(publicId),
  });

  // Countdown for a pending outgoing request.
  const now = useTicker(outgoingRequest !== null);

  const notFound = lookup.isSuccess && !lookup.data.exists;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserSearch className="size-4 text-primary" aria-hidden="true" />
          Написать по User ID
        </CardTitle>
        <CardDescription>
          Человек получит заявку и сам решит, принимать её или нет. Регистрация не нужна ни вам, ни
          ему.
        </CardDescription>

        {/*
          The one privacy cost of this flow, stated before the button is pressed: the person
          being asked sees who is asking. Someone who has decided they are anonymous here
          must not discover the opposite only after a stranger quotes their User ID back at
          them.
        */}
        <p className="text-xs text-muted-foreground">
          В отличие от случайного чата, здесь получатель увидит ваш User ID
          {ownPublicId ? (
            <>
              {' — '}
              <code className="font-mono">{formatPublicIdForDisplay(ownPublicId)}</code>
            </>
          ) : null}
          . Иначе он не сможет понять, кто с ним хочет поговорить.
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(input.trim());
          }}
        >
          <label className="sr-only" htmlFor="target-user-id">
            User ID собеседника
          </label>
          <Input
            id="target-user-id"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="AL7KM3-9PQ2-XRZ4"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            maxLength={32}
          />
          <Button type="submit" disabled={input.trim().length === 0}>
            <Search className="size-4" aria-hidden="true" />
            Проверить
          </Button>
        </form>

        {/* --- format feedback ------------------------------------------------ */}
        {submitted !== null && !formatValid ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
            Неверный формат. User ID состоит из 14 символов и начинается с AL.
          </p>
        ) : null}

        {isSelf ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
            Это ваш собственный User ID.
          </p>
        ) : null}

        {/* --- lookup result -------------------------------------------------- */}
        {formatValid && !isSelf && lookup.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Проверяем…
          </p>
        ) : null}

        {formatValid && !isSelf && lookup.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {describeError(lookup.error)}
          </p>
        ) : null}

        {formatValid && !isSelf && lookup.isSuccess ? (
          <div className="rounded-lg border border-border bg-muted/50 p-3">
            {notFound ? (
              <p className="text-sm text-muted-foreground">
                Пользователь с таким ID не найден. Проверьте, нет ли опечатки.
              </p>
            ) : lookup.data.acceptsRequests ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-sm">
                  <CircleCheck className="size-4 text-success" aria-hidden="true" />
                  Пользователь найден и принимает заявки.
                </p>
                <Button
                  size="sm"
                  onClick={() => send.mutate(normalized)}
                  disabled={send.isPending || outgoingRequest !== null}
                >
                  {send.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="size-4" aria-hidden="true" />
                  )}
                  Отправить заявку
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Пользователь найден, но он отключил входящие заявки.
              </p>
            )}
          </div>
        ) : null}

        {/* --- pending outgoing request --------------------------------------- */}
        {outgoingRequest ? (
          <div className="rounded-lg border border-primary/40 bg-accent/40 p-3" role="status">
            <p className="flex items-center gap-2 text-sm">
              <Timer className="size-4 shrink-0 text-primary" aria-hidden="true" />
              Заявка отправлена. Ждём ответа — она истечёт через{' '}
              <span className="font-mono tabular-nums">
                {formatRemaining(outgoingRequest.expiresAt, now)}
              </span>
              .
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
