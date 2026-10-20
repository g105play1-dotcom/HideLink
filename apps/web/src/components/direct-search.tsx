'use client';

import {
  isValidPublicId,
  normalizePublicId,
  formatPublicIdForDisplay,
  type UserLookupView,
} from '@anonlink/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, LoaderCircle, Search, Send, Timer } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { client } from '@/lib/anonymous-client';
import { describeError } from '@/lib/error-text';
import { formatRemaining } from '@/lib/format';
import { apiRequest } from '@/lib/http';
import { useTicker } from '@/lib/use-ticker';
import { useAppStore } from '@/store/app-store';

/**
 * Direct contact by User ID — one row under the identity block.
 *
 * This used to live on its own tab, which meant the second-most likely thing a new user
 * wants to do required knowing there was a tab for it. It is now the field the owner
 * asked for, directly under the ID they are meant to hand out
 * (docs/DECISIONS.md D22): "paste the ID of the person you want to talk to and press
 * find".
 *
 * The flow is still deliberately two steps — look up, then send — because the first step
 * is the one that can fail for a reason the user can act on (the ID does not exist, or
 * the person disabled requests). Sending blind would leave them guessing.
 *
 * Validation uses the *shared* schema, so the browser rejects a malformed ID before
 * spending a request on it, and the server applies exactly the same rule.
 */
export function DirectSearch() {
  const { locale, t } = useI18n();
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
    <section className="flex flex-col gap-2" aria-label={t('Чат по User ID')}>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(input.trim());
        }}
      >
        <label className="sr-only" htmlFor="target-user-id">
          {t('User ID собеседника')}
        </label>
        <Input
          id="target-user-id"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={t('Вставьте сюда ID собеседника')}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          maxLength={32}
        />
        <Button type="submit" disabled={input.trim().length === 0}>
          <Search className="size-4" aria-hidden="true" />
          {t('Найти')}
        </Button>
      </form>

      {/* --- format feedback ------------------------------------------------ */}
      {submitted !== null && !formatValid ? (
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          {t('Неверный формат. User ID состоит из 14 символов и начинается с AL.')}
        </p>
      ) : null}

      {isSelf ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          {t('Это ваш собственный User ID.')}
        </p>
      ) : null}

      {/* --- lookup result -------------------------------------------------- */}
      {formatValid && !isSelf && lookup.isPending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {t('Проверяем…')}
        </p>
      ) : null}

      {formatValid && !isSelf && lookup.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {describeError(lookup.error, locale)}
        </p>
      ) : null}

      {formatValid && !isSelf && lookup.isSuccess ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
          {notFound ? (
            <p className="text-sm text-muted-foreground">
              {t('Пользователь с таким ID не найден. Проверьте, нет ли опечатки.')}
            </p>
          ) : lookup.data.acceptsRequests ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-sm">
                  <CircleCheck className="size-4 text-success" aria-hidden="true" />
                  {t('Пользователь найден и принимает заявки.')}
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
                  {t('Отправить заявку')}
                </Button>
              </div>

              {/*
                The one privacy cost of this flow, stated before the button is pressed:
                the person being asked sees who is asking. Unlike a random match, this is
                not anonymous for the recipient, and it must not be discovered only after
                a stranger quotes your User ID back at you.
              */}
              {ownPublicId ? (
                /*
                  The ID used to sit *inside* this sentence as a `<code>`. That splits one
                  sentence into three text nodes, and a browser translator translates each
                  node on its own: the two halves arrive as unrelated fragments and the ID
                  itself gets treated as a word (docs/DECISIONS.md D29). The sentence is now
                  whole, and the ID is shown below it as a separate, untranslatable value.
                */
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'В отличие от случайного чата, получатель увидит ваш User ID — иначе он не поймёт, кто с ним хочет поговорить.',
                    )}
                  </p>
                  <code
                    translate="no"
                    className="w-fit rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
                  >
                    {formatPublicIdForDisplay(ownPublicId)}
                  </code>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('Пользователь найден, но он отключил входящие заявки.')}
            </p>
          )}
        </div>
      ) : null}

      {/* --- pending outgoing request --------------------------------------- */}
      {outgoingRequest ? (
        <div className="rounded-lg border border-primary/40 bg-accent/40 p-3">
          {/*
            The countdown lives on its own line, not inside the sentence. It changes every
            second: inside a sentence a browser translator would re-translate the sentence
            each tick, and a screen reader inside `role="status"` would announce it every
            second. The value itself is marked untranslatable — digits and a unit letter.
          */}
          <p className="flex items-center gap-2 text-sm" role="status">
            <Timer className="size-4 shrink-0 text-primary" aria-hidden="true" />
            {t('Заявка отправлена. Ждём ответа.')}
          </p>
          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t('Истекает через:')}</span>
            <span translate="no" className="font-mono tabular-nums">
              {formatRemaining(outgoingRequest.expiresAt, now, locale)}
            </span>
          </p>
        </div>
      ) : null}
    </section>
  );
}
