'use client';

import { useState } from 'react';

import {
  GENDERS,
  LANGUAGES,
  LOCATION_MODES,
  PROFILE_LIMITS,
  profileUpdateSchema,
  searchPreferencesSchema,
  type Gender,
  type Language,
  type LocationMode,
  type ProfileUpdate,
  type SearchPreferences,
  type SessionView,
} from '@anonlink/shared';
import { useMutation } from '@tanstack/react-query';
import { CircleAlert, Filter, Info, LoaderCircle, Save, UserRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { client } from '@/lib/anonymous-client';
import { describeError } from '@/lib/error-text';
import { apiRequest } from '@/lib/http';
import { GENDER_LABELS, LANGUAGE_LABELS, LOCATION_LABELS, describeCriteria } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { useAppStore, type SessionInfo } from '@/store/app-store';

/**
 * The data a filtered search is built on, and the filters themselves.
 *
 * ## What this screen promises, and what it must not
 *
 * Everything here is *self-declared and unverified*: there is no sign-up to verify it
 * against, so a user can claim any age, gender or city they like. The interface says so in
 * plain words and never implies otherwise — a filter is a preference hint for the
 * matchmaker, not a fact about a person. None of it is ever shown to the peer, who only
 * ever sees a pseudonym.
 *
 * ## Why the "save" button is disabled by a validation error
 *
 * The browser validates with the *same* schemas the server does, so an impossible filter
 * set — most importantly an inverted age range, which matches nobody and would look like
 * a broken search — is caught before a request is made. The server still validates: this
 * is a courtesy, not a boundary.
 */

const CHIP = 'rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:opacity-60';
const CHIP_ON = 'border-primary bg-accent/50 font-medium';
const CHIP_OFF = 'border-border hover:bg-muted';

function chipClass(active: boolean): string {
  return cn(CHIP, active ? CHIP_ON : CHIP_OFF);
}

/** A set of toggle buttons over one vocabulary. */
function MultiChoice<T extends string>({
  legend,
  options,
  selected,
  onToggle,
  labelFor,
  disabled,
}: {
  legend: string;
  options: readonly T[];
  selected: readonly T[];
  onToggle: (value: T) => void;
  labelFor: (value: T) => string;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={selected.includes(option)}
            onClick={() => onToggle(option)}
            className={chipClass(selected.includes(option))}
          >
            {labelFor(option)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** One choice out of a vocabulary, optionally including "not stated" (`null`). */
function SingleChoice<T extends string>({
  legend,
  options,
  value,
  onChange,
  labelFor,
  disabled,
}: {
  legend: string;
  options: readonly (T | null)[];
  value: T | null;
  onChange: (value: T | null) => void;
  labelFor: (value: T | null) => string;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option ?? 'unstated'}
            type="button"
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            className={chipClass(value === option)}
          >
            {labelFor(option)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Empty input means "no bound"; anything else must be a whole number. */
function parseBound(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
}

function boundValue(value: number | null): string {
  return value === null ? '' : String(value);
}

function firstProblem(result: { error: { issues: Array<{ message: string }> } }): string {
  // The only cross-field rule the filters have, and the one a user can actually hit.
  if (result.error.issues.some((issue) => issue.message === 'AGE_RANGE_INVERTED')) {
    return 'Нижняя граница возраста больше верхней — так не найдётся никто.';
  }

  return 'Проверьте значения: сервер отклонит такие фильтры.';
}

export function SearchPreferencesPanel({ session }: { session: SessionInfo }) {
  // --- declared profile (what the matchmaker knows about me) -----------------
  const [gender, setGender] = useState<Gender | null>(session.profile.gender);
  const [birthYear, setBirthYear] = useState(boundValue(session.profile.birthYear));
  const [city, setCity] = useState(session.profile.city ?? '');
  const [region, setRegion] = useState(session.profile.region ?? '');
  const [declaredLanguages, setDeclaredLanguages] = useState<Language[]>([
    ...session.profile.languages,
  ]);

  // --- filters (whom I want to meet) ----------------------------------------
  const [genders, setGenders] = useState<Gender[]>([...session.search.genders]);
  const [ageMin, setAgeMin] = useState(boundValue(session.search.ageMin));
  const [ageMax, setAgeMax] = useState(boundValue(session.search.ageMax));
  const [location, setLocation] = useState<LocationMode>(session.search.location);
  const [filterLanguages, setFilterLanguages] = useState<Language[]>([...session.search.languages]);
  const [relaxAllowed, setRelaxAllowed] = useState(session.search.relaxAllowed);

  const saveProfile = useMutation({
    mutationFn: (profile: ProfileUpdate) =>
      apiRequest<SessionView>('/me/settings', { method: 'PATCH', json: { profile } }),
    onSuccess: (updated) => {
      client.applySession(updated);
      useAppStore.getState().notify('success', 'Данные о себе сохранены.');
    },
  });

  const saveFilters = useMutation({
    mutationFn: (search: SearchPreferences) =>
      apiRequest<SessionView>('/me/settings', { method: 'PATCH', json: { search } }),
    onSuccess: (updated) => {
      client.applySession(updated);
      useAppStore.getState().notify('success', 'Фильтры поиска сохранены.');
    },
  });

  const profileDraft = profileUpdateSchema.safeParse({
    gender,
    birthYear: parseBound(birthYear),
    // An empty field means "I no longer want to say", which is `null` on the wire.
    city: city.trim() === '' ? null : city.trim(),
    region: region.trim() === '' ? null : region.trim(),
    languages: declaredLanguages,
  });

  const filtersDraft = searchPreferencesSchema.safeParse({
    genders,
    ageMin: parseBound(ageMin),
    ageMax: parseBound(ageMax),
    location,
    languages: filterLanguages,
    relaxAllowed,
  });

  const criteriaPreview = filtersDraft.success ? describeCriteria(filtersDraft.data) : [];

  function toggle<T>(list: readonly T[], value: T): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserRound className="size-4 text-primary" aria-hidden="true" />
            Что о вас знает поиск
          </CardTitle>
          <CardDescription>
            Данные указываете вы сами, и проверить их нечем — регистрации в AnonLink нет. Они нужны
            только алгоритму подбора: собеседник их никогда не видит, он видит только ваш псевдоним.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          <SingleChoice
            legend="Ваш пол"
            options={[null, ...GENDERS]}
            value={gender}
            onChange={setGender}
            labelFor={(value) => (value === null ? 'Не указывать' : GENDER_LABELS[value])}
            disabled={saveProfile.isPending}
          />

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="profile-birth-year">
              Год рождения
            </label>
            <Input
              id="profile-birth-year"
              inputMode="numeric"
              placeholder="Например, 1996"
              value={birthYear}
              onChange={(event) => setBirthYear(event.target.value)}
              disabled={saveProfile.isPending}
              aria-invalid={!profileDraft.success}
            />
            <p className="text-xs text-muted-foreground">
              Не возраст, а год: возраст пришлось бы обновлять вручную. По нему работает фильтр
              «возраст» у других людей.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="profile-city">
                Город
              </label>
              <Input
                id="profile-city"
                placeholder="Москва"
                maxLength={PROFILE_LIMITS.PLACE_MAX_LENGTH}
                value={city}
                onChange={(event) => setCity(event.target.value)}
                disabled={saveProfile.isPending}
              />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="profile-region">
                Регион
              </label>
              <Input
                id="profile-region"
                placeholder="Московская область"
                maxLength={PROFILE_LIMITS.PLACE_MAX_LENGTH}
                value={region}
                onChange={(event) => setRegion(event.target.value)}
                disabled={saveProfile.isPending}
              />
            </div>
          </div>

          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Место — это просто слова, которые вы вводите: приложение не запрашивает геолокацию и не
            определяет адрес. «Спб» и «Санкт-Петербург» — разные строки.
          </p>

          <MultiChoice
            legend="Языки, на которых вам удобно общаться"
            options={LANGUAGES}
            selected={declaredLanguages}
            onToggle={(value) => setDeclaredLanguages((current) => toggle(current, value))}
            labelFor={(value) => LANGUAGE_LABELS[value]}
            disabled={saveProfile.isPending}
          />

          {!profileDraft.success ? (
            <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
              <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
              {firstProblem(profileDraft)}
            </p>
          ) : null}

          {saveProfile.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {describeError(saveProfile.error)}
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            <Button
              disabled={!profileDraft.success || saveProfile.isPending}
              onClick={() => {
                if (profileDraft.success) saveProfile.mutate(profileDraft.data);
              }}
            >
              {saveProfile.isPending ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Save className="size-4" aria-hidden="true" />
              )}
              Сохранить данные
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="size-4 text-primary" aria-hidden="true" />
            Кого искать в случайном чате
          </CardTitle>
          <CardDescription>
            Фильтры работают на сервере: подбираются только те, кто подходит под них, — и только
            если вы сами подходите под фильтры собеседника. Если фильтр никто не выполняет, поиск
            просто не находит никого.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          <MultiChoice
            legend="Пол собеседника"
            options={GENDERS}
            selected={genders}
            onToggle={(value) => setGenders((current) => toggle(current, value))}
            labelFor={(value) => GENDER_LABELS[value]}
            disabled={saveFilters.isPending}
          />

          <fieldset className="flex flex-col gap-2" disabled={saveFilters.isPending}>
            <legend className="text-sm font-medium">Возраст собеседника</legend>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Минимальный возраст"
                className="w-24"
                inputMode="numeric"
                placeholder="от"
                value={ageMin}
                onChange={(event) => setAgeMin(event.target.value)}
              />
              <span className="text-sm text-muted-foreground">—</span>
              <Input
                aria-label="Максимальный возраст"
                className="w-24"
                inputMode="numeric"
                placeholder="до"
                value={ageMax}
                onChange={(event) => setAgeMax(event.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Считается по указанному году рождения, поэтому возраст приблизительный. Ограничений по
              возрасту нет: и границы, и пустое поле — ваше решение.
            </p>
          </fieldset>

          <SingleChoice
            legend="Где искать"
            options={LOCATION_MODES}
            value={location}
            onChange={(value) => {
              // `LOCATION_MODES` has no "not stated": 'any' *is* the neutral value.
              if (value !== null) setLocation(value);
            }}
            labelFor={(value) => (value === null ? '' : LOCATION_LABELS[value])}
            disabled={saveFilters.isPending}
          />

          <MultiChoice
            legend="Общий язык"
            options={LANGUAGES}
            selected={filterLanguages}
            onToggle={(value) => setFilterLanguages((current) => toggle(current, value))}
            labelFor={(value) => LANGUAGE_LABELS[value]}
            disabled={saveFilters.isPending}
          />

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Если подходящего собеседника долго нет</span>
            {/*
              The button's name is the *setting*, never its current value: a toggle whose
              label flips between "Ничего не снимать" and "Разрешить снимать фильтры по
              одному" reads as an instruction and does the opposite of what it says when it
              is already on. The value is carried by `aria-pressed` and by the words next to
              it, which is also what a screen reader announces.
            */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-pressed={relaxAllowed}
                disabled={saveFilters.isPending}
                onClick={() => setRelaxAllowed((current) => !current)}
                className={chipClass(relaxAllowed)}
              >
                Снимать фильтры по одному
              </button>
              <span className="text-sm text-muted-foreground">
                {relaxAllowed ? 'Разрешено' : 'Запрещено'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Если разрешено, сервер начнёт по одному снимать ваши фильтры — от менее важного к
              более важному — и каждый раз напишет, какой именно снят. Собеседник при этом никогда
              не получит ничего сверх обычного: он по-прежнему видит только псевдоним. Точное время
              до первого снятия видно на экране поиска.
            </p>
          </div>

          <div className="rounded-lg border border-border p-3">
            <p className="text-xs font-medium text-muted-foreground">Что будет применяться</p>
            {criteriaPreview.length === 0 ? (
              <p className="mt-1 text-sm">Без фильтров — подойдёт любой собеседник.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-0.5 text-sm">
                {criteriaPreview.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>

          {!filtersDraft.success ? (
            <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
              <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
              {firstProblem(filtersDraft)}
            </p>
          ) : null}

          {saveFilters.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {describeError(saveFilters.error)}
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            <Button
              disabled={!filtersDraft.success || saveFilters.isPending}
              onClick={() => {
                if (filtersDraft.success) saveFilters.mutate(filtersDraft.data);
              }}
            >
              {saveFilters.isPending ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Save className="size-4" aria-hidden="true" />
              )}
              Сохранить фильтры
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
