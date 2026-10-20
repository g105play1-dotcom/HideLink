'use client';

import {
  ARCHIVE_RETENTION_MAX_DAYS,
  ErrorCode,
  GENDERS,
  LANGUAGES,
  MEDIA_KINDS,
  REPORT_STATUSES,
  type AdminIdentityListResponse,
  type AdminPlatformView,
  type AdminReportListResponse,
  type AdminReportView,
  type AdminStatusView,
  type ArchiveDeletionResponse,
  type ArchiveListResponse,
  type ArchivePolicy,
  type ArchivedChatSummaryView,
  type ArchivedChatView,
  type Gender,
  type MediaKind,
  type OwnerMessageListResponse,
  type OwnerMessageView,
  type ReportStatus,
} from '@anonlink/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArchiveRestore,
  CircleAlert,
  Eraser,
  Flag,
  Inbox,
  KeyRound,
  LoaderCircle,
  LogOut,
  ShieldCheck,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { describeError, REPORT_REASON_LABELS } from '@/lib/error-text';
import { apiRequest } from '@/lib/http';
import { LANGUAGE_LABELS, OWNER_TOPIC_LABELS } from '@/lib/labels';

/**
 * The owner's archive page.
 *
 * ## Why it is a page of its own
 *
 * This screen is not part of the product: nothing links to it, it is `noindex`, and it
 * only appears for someone who knows the URL *and* has the owner key. Users are never
 * told that archiving exists, so there is deliberately no navigation towards it.
 *
 * ## Why it exists at all
 *
 * The owner asked (2026-10-19) for the ability to keep transcripts and to decide by hand
 * who, what and how long. Doing that only through `psql` would make the feature unusable
 * by the person who asked for it, and would make every deletion a manual SQL statement.
 *
 * ## What it cannot do
 *
 * It cannot read a conversation that the policy did not select, and it cannot widen the
 * policy: every write is validated and enforced by the server. This page is a client of
 * the same API a script would use.
 */

const GENDER_LABELS: Record<Gender, string> = {
  female: 'Женщина',
  male: 'Мужчина',
};

const MEDIA_LABELS: Record<MediaKind, string> = {
  image: 'Изображения',
  video: 'Видео',
  audio: 'Аудио',
  file: 'Файлы',
};

const AUDIENCE_OPTIONS = [
  {
    value: 'everyone',
    label: 'Все пользователи',
    hint: 'Сохраняется каждый чат, который начнётся при включённом хранении.',
  },
  {
    value: 'criteria',
    label: 'По параметрам',
    hint: 'Сохраняются чаты, в которых хотя бы один участник подходит под условия ниже.',
  },
  {
    value: 'selected',
    label: 'Только выбранные',
    hint: 'Сохраняются чаты, в которых участвует хотя бы один из указанных User ID.',
  },
] as const;

/** How the owner's screen names each state of a report. Exhaustive by type. */
const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  open: 'Открыта',
  reviewed: 'Просмотрена',
  actioned: 'Приняты меры',
  dismissed: 'Отклонена',
};

const timestampFormat = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short',
  timeStyle: 'short',
});

function formatTimestamp(value: string | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : timestampFormat.format(date);
}

function splitList(text: string): string[] {
  const values = text
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(values)];
}

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function AdminScreen() {
  const status = useQuery({
    queryKey: ['admin', 'status'],
    queryFn: () => apiRequest<AdminStatusView>('/admin/status'),
    retry: false,
  });

  const available = status.isSuccess && status.data.available;

  /**
   * Asks the server whether this browser is already the owner.
   *
   * The key is exchanged for a cookie that outlives a reload, so assuming "not signed in"
   * on every mount would make the owner paste the key again after each refresh for no
   * reason. This shares its cache entry with the panel's own policy query, so it costs no
   * extra request once the panel is mounted.
   */
  const probe = useQuery({
    queryKey: ['admin', 'policy'],
    queryFn: () => apiRequest<ArchivePolicy>('/admin/policy'),
    enabled: available,
    retry: false,
  });

  const [unlocked, setUnlocked] = useState(false);
  const signedIn = unlocked || probe.isSuccess;

  return (
    <main id="main" className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Архив переписок</h1>
        <p className="text-sm text-muted-foreground">
          Страница владельца. Доступ есть только у того, кто знает ключ из файла настроек сервера.
        </p>
      </header>

      {status.isPending ? (
        <Card>
          <CardContent className="flex items-center gap-2 pt-6 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Проверяю доступ…
          </CardContent>
        </Card>
      ) : null}

      {status.isError ? <ErrorLine error={status.error} /> : null}

      {status.isSuccess && !status.data.available ? (
        <Card>
          <CardHeader>
            <CardTitle>Хранилище выключено</CardTitle>
            <CardDescription>
              На этом сервере не задан ключ владельца, поэтому страница недоступна. Это безопасное
              состояние по умолчанию: без ключа архив не существует.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {available && !signedIn && probe.isPending ? (
        <Card>
          <CardContent className="flex items-center gap-2 pt-6 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Проверяю доступ…
          </CardContent>
        </Card>
      ) : null}

      {available && !signedIn && probe.isError ? (
        <KeyGate onUnlocked={() => setUnlocked(true)} />
      ) : null}

      {available && signedIn ? <AdminPanel onLocked={() => setUnlocked(false)} /> : null}
    </main>
  );
}

/**
 * The key form.
 *
 * The key is sent once and exchanged for an `HttpOnly` cookie by the server, so it never
 * has to be kept in `localStorage` — where any script on the page could read it.
 */
function KeyGate({ onUnlocked }: { onUnlocked: () => void }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');

  const open = useMutation({
    mutationFn: () => apiRequest<void>('/admin/session', { method: 'POST', json: { token } }),
    onSuccess: async () => {
      setToken('');
      // The failed probe is still cached as an error; drop it so the panel fetches with
      // the cookie the server just set instead of showing the error it inherited. Only the
      // policy key is reset: resetting `['admin']` would also reset the availability probe
      // and flash "Проверяю доступ…" over a page that is already open.
      await queryClient.resetQueries({ queryKey: ['admin', 'policy'] });
      onUnlocked();
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (token.trim().length === 0) return;
    open.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-primary" aria-hidden="true" />
          Ключ владельца
        </CardTitle>
        <CardDescription>
          Длинная строка, заданная в <code className="font-mono text-xs">ADMIN_TOKEN</code> в файле{' '}
          <code className="font-mono text-xs">.env</code>. Вводится один раз: сервер запоминает вход
          на несколько часов, поэтому после перезагрузки страницы ключ не спрашивают.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <label className="flex flex-col gap-1 text-sm font-medium" htmlFor="admin-key">
            Ключ
            <Input
              id="admin-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Вставьте ключ"
            />
          </label>

          {open.isError ? <ErrorLine error={open.error} /> : null}

          <div>
            <Button type="submit" disabled={open.isPending || token.trim().length === 0}>
              {open.isPending ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              Открыть архив
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function AdminPanel({ onLocked }: { onLocked: () => void }) {
  const queryClient = useQueryClient();

  const policy = useQuery({
    queryKey: ['admin', 'policy'],
    queryFn: () => apiRequest<ArchivePolicy>('/admin/policy'),
    retry: false,
  });

  const archives = useQuery({
    queryKey: ['admin', 'archives'],
    queryFn: () => apiRequest<ArchiveListResponse>('/admin/archives'),
    refetchInterval: 10_000,
    retry: false,
  });

  const inbox = useQuery({
    queryKey: ['admin', 'messages'],
    queryFn: () => apiRequest<OwnerMessageListResponse>('/admin/messages'),
    refetchInterval: 10_000,
    retry: false,
  });

  const platform = useQuery({
    queryKey: ['admin', 'platform'],
    queryFn: () => apiRequest<AdminPlatformView>('/admin/platform'),
    retry: false,
  });

  const reports = useQuery({
    queryKey: ['admin', 'reports'],
    queryFn: () => apiRequest<AdminReportListResponse>('/admin/reports'),
    refetchInterval: 10_000,
    retry: false,
  });

  const [openChatId, setOpenChatId] = useState<string | null>(null);

  // Signing out and re-entering the key both have to drop the cached policy, because the
  // screen above decides between the key form and this panel by whether that query
  // succeeded. Without it the panel would keep rendering — or the button below would look
  // dead — while the server already refuses the requests.
  const forgetSession = () => {
    queryClient.removeQueries({ queryKey: ['admin', 'policy'] });
    queryClient.removeQueries({ queryKey: ['admin', 'archives'] });
    queryClient.removeQueries({ queryKey: ['admin', 'messages'] });
    queryClient.removeQueries({ queryKey: ['admin', 'platform'] });
    queryClient.removeQueries({ queryKey: ['admin', 'reports'] });
  };

  const lock = useMutation({
    mutationFn: () => apiRequest<void>('/admin/session', { method: 'DELETE' }),
    onSuccess: () => {
      forgetSession();
      onLocked();
    },
  });

  const expired =
    (policy.isError && readCode(policy.error) === ErrorCode.ADMIN_AUTH_REQUIRED) ||
    (archives.isError && readCode(archives.error) === ErrorCode.ADMIN_AUTH_REQUIRED) ||
    (inbox.isError && readCode(inbox.error) === ErrorCode.ADMIN_AUTH_REQUIRED) ||
    (platform.isError && readCode(platform.error) === ErrorCode.ADMIN_AUTH_REQUIRED) ||
    (reports.isError && readCode(reports.error) === ErrorCode.ADMIN_AUTH_REQUIRED);

  if (expired) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 pt-6">
          <p className="text-sm text-destructive" role="alert">
            Ключ больше не действует. Введите его снова.
          </p>
          <Button
            onClick={() => {
              forgetSession();
              onLocked();
            }}
          >
            Ввести ключ
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Изменения вступают в силу сразу. Уже начатые чаты, которые не попали в архив, задним
          числом не сохраняются.
        </p>
        <Button variant="outline" size="sm" onClick={() => lock.mutate()} disabled={lock.isPending}>
          <LogOut className="size-4" aria-hidden="true" />
          Выйти
        </Button>
      </div>

      {policy.isPending ? (
        <Card>
          <CardContent className="flex items-center gap-2 pt-6 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Загружаю настройки…
          </CardContent>
        </Card>
      ) : null}

      {policy.isError ? <ErrorLine error={policy.error} /> : null}

      {policy.isSuccess ? <PolicyEditor policy={policy.data} /> : null}

      <ModerationPanel
        platform={platform.data ?? null}
        platformLoading={platform.isPending}
        platformError={platform.isError ? platform.error : null}
        reports={reports.data?.reports ?? []}
        reportsLoading={reports.isPending}
        reportsError={reports.isError ? reports.error : null}
      />

      <OwnerInbox
        messages={inbox.data?.messages ?? []}
        loading={inbox.isPending}
        error={inbox.isError ? inbox.error : null}
      />

      <ArchiveList
        archives={archives.data?.archives ?? []}
        loading={archives.isPending}
        error={archives.isError ? archives.error : null}
        openChatId={openChatId}
        onOpen={setOpenChatId}
      />
    </div>
  );
}

function PolicyEditor({ policy }: { policy: ArchivePolicy }) {
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<ArchivePolicy>(policy);
  const [citiesText, setCitiesText] = useState(policy.criteria.cities.join(', '));
  const [regionsText, setRegionsText] = useState(policy.criteria.regions.join(', '));
  const [search, setSearch] = useState('');

  const save = useMutation({
    mutationFn: (next: ArchivePolicy) =>
      apiRequest<ArchivePolicy>('/admin/policy', { method: 'PUT', json: next }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['admin', 'policy'], saved);
      setDraft(saved);
      setCitiesText(saved.criteria.cities.join(', '));
      setRegionsText(saved.criteria.regions.join(', '));
    },
  });

  const found = useQuery({
    queryKey: ['admin', 'identities', search],
    queryFn: () =>
      apiRequest<AdminIdentityListResponse>(
        `/admin/identities?q=${encodeURIComponent(search.trim())}`,
      ),
    enabled: search.trim().length >= 4,
  });

  const criteria = draft.criteria;
  const criteriaIsEmpty =
    criteria.genders.length === 0 &&
    criteria.ageMin === null &&
    criteria.ageMax === null &&
    criteria.cities.length === 0 &&
    criteria.regions.length === 0 &&
    criteria.languages.length === 0;

  // Mirrors the server's cross-field rules, so the owner sees the reason *before* a
  // request is refused rather than as a generic "некорректные данные".
  const problem = !draft.enabled
    ? null
    : !draft.storeText && draft.storeMedia.length === 0
      ? 'Включите хранение текста или хотя бы один тип вложений.'
      : draft.audience === 'criteria' && criteriaIsEmpty
        ? 'Для отбора по параметрам задайте хотя бы один параметр.'
        : draft.audience === 'selected' && draft.selectedPublicIds.length === 0
          ? 'Добавьте хотя бы один User ID.'
          : criteria.ageMin !== null &&
              criteria.ageMax !== null &&
              criteria.ageMin > criteria.ageMax
            ? 'Минимальный возраст больше максимального.'
            : null;

  const updateCriteria = (patch: Partial<ArchivePolicy['criteria']>) => {
    setDraft((current) => ({ ...current, criteria: { ...current.criteria, ...patch } }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (problem) return;

    save.mutate({
      ...draft,
      criteria: {
        ...draft.criteria,
        cities: splitList(citiesText),
        regions: splitList(regionsText),
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArchiveRestore className="size-4 text-primary" aria-hidden="true" />
          Что сохранять
        </CardTitle>
        <CardDescription>
          Выключено — ничего не записывается. Каждое сообщение проверяется в момент отправки,
          поэтому выключение действует немедленно.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="size-4"
              checked={draft.enabled}
              onChange={(event) =>
                setDraft((current) => ({ ...current, enabled: event.target.checked }))
              }
            />
            Хранить переписку
          </label>

          <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium">Кого охватывает архив</legend>

            {AUDIENCE_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="audience"
                  className="mt-1 size-4"
                  value={option.value}
                  checked={draft.audience === option.value}
                  onChange={() => setDraft((current) => ({ ...current, audience: option.value }))}
                />
                <span className="flex flex-col">
                  <span className="font-medium">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {draft.audience === 'criteria' ? (
            <fieldset className="flex flex-col gap-4 rounded-lg border border-border p-3">
              <legend className="px-1 text-sm font-medium">Параметры отбора</legend>

              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Пол</span>
                <div className="flex flex-wrap gap-3">
                  {GENDERS.map((gender) => (
                    <label key={gender} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={criteria.genders.includes(gender)}
                        onChange={() =>
                          updateCriteria({ genders: toggle(criteria.genders, gender) })
                        }
                      />
                      {GENDER_LABELS[gender]}
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <label className="flex w-32 flex-col gap-1 text-sm" htmlFor="archive-age-min">
                  Возраст от
                  <Input
                    id="archive-age-min"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={120}
                    value={criteria.ageMin ?? ''}
                    onChange={(event) => updateCriteria({ ageMin: parseBound(event.target.value) })}
                  />
                </label>
                <label className="flex w-32 flex-col gap-1 text-sm" htmlFor="archive-age-max">
                  Возраст до
                  <Input
                    id="archive-age-max"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={120}
                    value={criteria.ageMax ?? ''}
                    onChange={(event) => updateCriteria({ ageMax: parseBound(event.target.value) })}
                  />
                </label>
              </div>

              <label className="flex flex-col gap-1 text-sm" htmlFor="archive-cities">
                Города (через запятую)
                <Input
                  id="archive-cities"
                  value={citiesText}
                  onChange={(event) => setCitiesText(event.target.value)}
                  placeholder="Москва, Казань"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm" htmlFor="archive-regions">
                Регионы (через запятую)
                <Input
                  id="archive-regions"
                  value={regionsText}
                  onChange={(event) => setRegionsText(event.target.value)}
                  placeholder="Московская область"
                />
              </label>

              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Языки</span>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {LANGUAGES.map((language) => (
                    <label key={language} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={criteria.languages.includes(language)}
                        onChange={() =>
                          updateCriteria({ languages: toggle(criteria.languages, language) })
                        }
                      />
                      {LANGUAGE_LABELS[language]}
                    </label>
                  ))}
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                Незаявленный параметр не считается совпадением — так же, как в фильтрах поиска.
              </p>
            </fieldset>
          ) : null}

          {draft.audience === 'selected' ? (
            <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
              <legend className="px-1 text-sm font-medium">Выбранные User ID</legend>

              {draft.selectedPublicIds.length === 0 ? (
                <p className="text-sm text-muted-foreground">Пока никто не выбран.</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {draft.selectedPublicIds.map((publicId) => (
                    <li
                      key={publicId}
                      className="flex items-center gap-2 rounded-lg border border-border px-2 py-1"
                    >
                      <code className="font-mono text-xs">{publicId}</code>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Убрать ${publicId}`}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            selectedPublicIds: current.selectedPublicIds.filter(
                              (value) => value !== publicId,
                            ),
                          }))
                        }
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              <label className="flex flex-col gap-1 text-sm" htmlFor="archive-user-search">
                Найти по User ID (можно ввести начало)
                <Input
                  id="archive-user-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="AL…"
                />
              </label>

              {found.isFetching ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                  Ищу…
                </p>
              ) : null}

              {found.isError ? <ErrorLine error={found.error} /> : null}

              {found.isSuccess ? (
                found.data.identities.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Никого не найдено.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {found.data.identities.map((identity) => {
                      const already = draft.selectedPublicIds.includes(identity.publicId);

                      return (
                        <li
                          key={identity.publicId}
                          className="flex items-center justify-between gap-2 text-sm"
                        >
                          <code className="font-mono text-xs">{identity.publicId}</code>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={already}
                            onClick={() =>
                              setDraft((current) => ({
                                ...current,
                                selectedPublicIds: [
                                  ...current.selectedPublicIds,
                                  identity.publicId,
                                ],
                              }))
                            }
                          >
                            <UserPlus className="size-4" aria-hidden="true" />
                            {already ? 'Уже выбран' : 'Добавить'}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )
              ) : null}
            </fieldset>
          ) : null}

          <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium">Что именно</legend>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={draft.storeText}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, storeText: event.target.checked }))
                }
              />
              Текст сообщений
            </label>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Вложения</span>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {MEDIA_KINDS.map((kind) => (
                  <label key={kind} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={draft.storeMedia.includes(kind)}
                      onChange={() =>
                        setDraft((current) => ({
                          ...current,
                          storeMedia: toggle(current.storeMedia, kind),
                        }))
                      }
                    />
                    {MEDIA_LABELS[kind]}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Вложения пока не поддерживаются самим чатом, поэтому эти флаги ничего не сохранят,
                пока такая возможность не появится.
              </p>
            </div>

            <label className="flex w-56 flex-col gap-1 text-sm" htmlFor="archive-retention">
              Хранить, дней
              <Input
                id="archive-retention"
                type="number"
                inputMode="numeric"
                min={0}
                max={ARCHIVE_RETENTION_MAX_DAYS}
                value={draft.retentionDays}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    retentionDays: Math.min(
                      ARCHIVE_RETENTION_MAX_DAYS,
                      Math.max(0, Number(event.target.value) || 0),
                    ),
                  }))
                }
              />
            </label>
            <p className="text-xs text-muted-foreground">
              0 — хранить, пока не удалите вручную. Иначе старое удаляется автоматически.
            </p>
          </fieldset>

          {problem ? (
            <p className="text-sm text-destructive" role="alert">
              {problem}
            </p>
          ) : null}

          {save.isError ? <ErrorLine error={save.error} /> : null}

          {save.isSuccess && !save.isPending ? (
            <p className="text-sm text-muted-foreground" role="status">
              Сохранено.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={save.isPending || problem !== null}>
              {save.isPending ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              Сохранить
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={() => {
                setDraft(policy);
                setCitiesText(policy.criteria.cities.join(', '));
                setRegionsText(policy.criteria.regions.join(', '));
              }}
            >
              Сбросить
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ModerationPanel({
  platform,
  platformLoading,
  platformError,
  reports,
  reportsLoading,
  reportsError,
}: {
  platform: AdminPlatformView | null;
  platformLoading: boolean;
  platformError: unknown;
  reports: readonly AdminReportView[];
  reportsLoading: boolean;
  reportsError: unknown;
}) {
  const queryClient = useQueryClient();

  const setBlocking = useMutation({
    mutationFn: (blockingEnabled: boolean) =>
      apiRequest<AdminPlatformView>('/admin/platform', {
        method: 'PUT',
        json: { blockingEnabled },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'platform'] }),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ReportStatus }) =>
      apiRequest<AdminReportView>(`/admin/reports/${id}`, {
        method: 'PATCH',
        json: { status },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'reports'] }),
  });

  const openCount = reports.filter((report) => report.status === 'open').length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" aria-hidden="true" />
          Модерация
        </CardTitle>
        <CardDescription>
          Что разрешено на площадке и жалобы пользователей. Статус жалобы — ваша пометка; он никому,
          кроме вас, не показывается.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="rounded-lg border border-border p-3">
          {platformLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Загружаю настройки…
            </p>
          ) : null}

          {platformError ? <ErrorLine error={platformError} /> : null}

          {platform ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={platform.blockingEnabled}
                disabled={setBlocking.isPending}
                onChange={(event) => setBlocking.mutate(event.target.checked)}
              />
              <span>
                <span className="font-medium">Разрешить блокировку собеседника</span>
                {/*
                  The honest consequence of the platform switch, and the reason the user's
                  own block list stays visible while it is off: switching a feature off is
                  not an amnesty, and it must not trap anyone with a block they cannot lift.
                */}
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Выключено — кнопки «Заблокировать» нет ни у кого, и сервер отказывает в новых
                  блокировках. Ранее созданные блокировки остаются в силе и остаются видимыми в
                  настройках того, кто их поставил.
                </span>
              </span>
            </label>
          ) : null}

          {setBlocking.isError ? <ErrorLine error={setBlocking.error} /> : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Flag className="size-4" aria-hidden="true" />
            Жалобы
            {openCount > 0 ? <Badge variant="accent">открытых: {openCount}</Badge> : null}
          </span>
          <span className="text-xs text-muted-foreground">
            Просроченные жалобы удаляются автоматически.
          </span>
        </div>

        {reportsLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Загружаю жалобы…
          </p>
        ) : null}

        {reportsError ? <ErrorLine error={reportsError} /> : null}

        {!reportsLoading && !reportsError && reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">Пока жалоб нет.</p>
        ) : null}

        {setStatus.isError ? <ErrorLine error={setStatus.error} /> : null}

        {reports.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {reports.map((report) => (
              <li key={report.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="accent">{REPORT_REASON_LABELS[report.reason]}</Badge>
                    <span className="text-muted-foreground">
                      {formatTimestamp(report.createdAt)}
                    </span>
                  </span>

                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    Статус
                    <select
                      aria-label={`Статус жалобы ${report.reporterPublicId}`}
                      className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                      value={report.status}
                      disabled={setStatus.isPending && setStatus.variables?.id === report.id}
                      onChange={(event) =>
                        setStatus.mutate({
                          id: report.id,
                          status: event.target.value as ReportStatus,
                        })
                      }
                    >
                      {REPORT_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {REPORT_STATUS_LABELS[status]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {report.details ? (
                  <p className="mt-2 text-sm whitespace-pre-wrap">{report.details}</p>
                ) : null}

                {report.messageSnapshot ? (
                  <blockquote className="mt-2 border-l-2 border-border pl-2 text-sm whitespace-pre-wrap text-muted-foreground">
                    {report.messageSnapshot}
                  </blockquote>
                ) : null}

                <p className="mt-2 text-xs text-muted-foreground">
                  От:{' '}
                  <span translate="no" className="font-mono">
                    {report.reporterPublicId}
                  </span>{' '}
                  · На:{' '}
                  <span translate="no" className="font-mono">
                    {report.targetPublicId}
                  </span>{' '}
                  · удалится {formatTimestamp(report.expiresAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function OwnerInbox({
  messages,
  loading,
  error,
}: {
  messages: readonly OwnerMessageView[];
  loading: boolean;
  error: unknown;
}) {
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ deleted: boolean }>(`/admin/messages/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'messages'] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Inbox className="size-4" aria-hidden="true" />
          Сообщения от пользователей
        </CardTitle>
        <CardDescription>
          Всё, что прислали через «Связаться с администрацией»: жалобы, предложения, вопросы по
          рекламе и сотрудничеству. Список обновляется автоматически; просроченные сообщения
          удаляются сами.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {remove.isError ? <ErrorLine error={remove.error} /> : null}

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Загружаю сообщения…
          </p>
        ) : null}

        {error ? <ErrorLine error={error} /> : null}

        {!loading && !error && messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">Пока сообщений нет.</p>
        ) : null}

        {messages.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {messages.map((message) => (
              <li key={message.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="accent">{OWNER_TOPIC_LABELS[message.topic]}</Badge>
                    <span className="text-muted-foreground">
                      {formatTimestamp(message.createdAt)}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (!window.confirm('Удалить это сообщение безвозвратно?')) return;
                      remove.mutate(message.id);
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    Удалить
                  </Button>
                </div>

                <p className="mt-2 text-sm whitespace-pre-wrap">{message.text}</p>

                <p className="mt-2 text-xs text-muted-foreground">
                  {message.publicId ? (
                    <>
                      User ID: <span className="font-mono">{message.publicId}</span> ·{' '}
                    </>
                  ) : null}
                  {message.contact ? <>Связь: {message.contact} · </> : null}
                  удалится {formatTimestamp(message.expiresAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ArchiveList({
  archives,
  loading,
  error,
  openChatId,
  onOpen,
}: {
  archives: readonly ArchivedChatSummaryView[];
  loading: boolean;
  error: unknown;
  openChatId: string | null;
  onOpen: (chatId: string | null) => void;
}) {
  const queryClient = useQueryClient();

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'archives'] });

  const remove = useMutation({
    mutationFn: (chatId: string) =>
      apiRequest<ArchiveDeletionResponse>(`/admin/archives/${chatId}`, { method: 'DELETE' }),
    onSuccess: async (_result, chatId) => {
      if (openChatId === chatId) onOpen(null);
      await refresh();
    },
  });

  const purgeExpired = useMutation({
    mutationFn: () =>
      apiRequest<ArchiveDeletionResponse>('/admin/archives/delete-expired', { method: 'POST' }),
    onSuccess: refresh,
  });

  const purgeAll = useMutation({
    mutationFn: () =>
      apiRequest<ArchiveDeletionResponse>('/admin/archives/delete-all', {
        method: 'POST',
        json: { confirm: true },
      }),
    onSuccess: async () => {
      onOpen(null);
      await refresh();
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Сохранённые переписки</CardTitle>
        <CardDescription>
          Список обновляется автоматически. Открыть можно только то, что уже сохранено.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={purgeExpired.isPending}
            onClick={() => purgeExpired.mutate()}
          >
            <Eraser className="size-4" aria-hidden="true" />
            Удалить просроченное
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={purgeAll.isPending || archives.length === 0}
            onClick={() => {
              if (!window.confirm('Удалить ВСЕ сохранённые переписки безвозвратно?')) return;
              purgeAll.mutate();
            }}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Удалить всё
          </Button>
        </div>

        {purgeExpired.isError ? <ErrorLine error={purgeExpired.error} /> : null}
        {purgeAll.isError ? <ErrorLine error={purgeAll.error} /> : null}
        {purgeExpired.isSuccess ? (
          <p className="text-sm text-muted-foreground" role="status">
            Удалено переписок: {purgeExpired.data.deletedArchives}, сообщений:{' '}
            {purgeExpired.data.deletedMessages}.
          </p>
        ) : null}
        {purgeAll.isSuccess ? (
          <p className="text-sm text-muted-foreground" role="status">
            Удалено переписок: {purgeAll.data.deletedArchives}, сообщений:{' '}
            {purgeAll.data.deletedMessages}.
          </p>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Загружаю список…
          </p>
        ) : null}

        {error ? <ErrorLine error={error} /> : null}

        {!loading && !error && archives.length === 0 ? (
          <p className="text-sm text-muted-foreground">Пока ничего не сохранено.</p>
        ) : null}

        {archives.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {archives.map((archive) => (
              <li key={archive.chatId} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {archive.participants.map((row) => row.publicId).join(' ↔ ')}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatTimestamp(archive.startedAt)} · сообщений: {archive.messageCount} ·
                      удалить после: {formatTimestamp(archive.expiresAt)}
                    </span>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-expanded={openChatId === archive.chatId}
                      onClick={() => onOpen(openChatId === archive.chatId ? null : archive.chatId)}
                    >
                      {openChatId === archive.chatId ? 'Свернуть' : 'Открыть'}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={remove.isPending}
                      aria-label={`Удалить переписку ${archive.participants
                        .map((row) => row.publicId)
                        .join(' и ')}`}
                      onClick={() => {
                        if (!window.confirm('Удалить эту переписку безвозвратно?')) return;
                        remove.mutate(archive.chatId);
                      }}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                {remove.isError && remove.variables === archive.chatId ? (
                  <div className="mt-2">
                    <ErrorLine error={remove.error} />
                  </div>
                ) : null}

                {openChatId === archive.chatId ? <Transcript chatId={archive.chatId} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Transcript({ chatId }: { chatId: string }) {
  const transcript = useQuery({
    queryKey: ['admin', 'archive', chatId],
    queryFn: () => apiRequest<ArchivedChatView>(`/admin/archives/${chatId}`),
    retry: false,
  });

  return (
    <div className="mt-3 border-t border-border pt-3">
      {transcript.isPending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          Загружаю переписку…
        </p>
      ) : null}

      {transcript.isError ? <ErrorLine error={transcript.error} /> : null}

      {transcript.isSuccess && transcript.data.messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Сообщений нет: возможно, сохранялись только вложения.
        </p>
      ) : null}

      {transcript.isSuccess && transcript.data.messages.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {transcript.data.messages.map((message) => (
            <li key={`${message.seq}-${message.sentAt}`} className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <code className="font-mono">{message.senderPublicId}</code>
                <span>{formatTimestamp(message.sentAt)}</span>
                {message.mediaKind ? <span>вложение: {message.mediaKind}</span> : null}
              </span>
              <span className="whitespace-pre-wrap break-words text-sm">{message.text ?? '—'}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function ErrorLine({ error }: { error: unknown }): ReactNode {
  return (
    <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
      <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
      {describeError(error)}
    </p>
  );
}

/** Reads the stable error code off anything that was thrown, without a cast at the call site. */
function readCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** Empty input means "no bound"; anything else must be a whole number of years. */
function parseBound(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : null;
}
