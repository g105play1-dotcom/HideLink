'use client';

import {
  ageFromBirthYear,
  birthYearFromAge,
  GENDERS,
  LANGUAGES,
  normalizePlace,
  PROFILE_LIMITS,
  profileUpdateSchema,
  searchPreferencesSchema,
  type BlockListResponse,
  type Gender,
  type IncomingRequestPolicy,
  type Language,
  type ProfileUpdate,
  type SearchPreferences,
  type SessionView,
} from '@anonlink/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  CircleAlert,
  LoaderCircle,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  X,
} from 'lucide-react';
import { useState } from 'react';

import { Combobox } from '@/components/combobox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { CITY_SUGGESTIONS, REGION_SUGGESTIONS } from '@/data/places';
import { client } from '@/lib/anonymous-client';
import { describeError } from '@/lib/error-text';
import { apiRequest } from '@/lib/http';
import { GENDER_LABELS, LANGUAGE_LABELS, describeCriteria } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { useAppStore, type SessionInfo } from '@/store/app-store';

/**
 * Everything the user can decide about matching and moderation.
 *
 * ## Why two columns
 *
 * The owner asked for the "about you" and "whom to look for" halves side by side, as in
 * the chat he is modelling the interface on. They are two halves of one question — a
 * filter is only meaningful next to the declaration it is compared against — so a person
 * filling in "жен., 25–35" can see what they claimed about themselves while doing it.
 * On a narrow screen they stack, declaration first.
 *
 * ## What this screen promises, and what it must not
 *
 * Everything in the left column is *self-declared and unverified*: there is no sign-up to
 * verify it against, so a user can claim any age, gender or city they like. It feeds the
 * matchmaker and nothing else — the peer never sees it, only a temporary pseudonym. The
 * interface says so in one line and never implies otherwise.
 *
 * ## Why the save button is disabled by a validation error
 *
 * The browser validates with the *same* schemas the server does, so an impossible filter
 * set — most obviously an inverted age range, which matches nobody and looks exactly like
 * a broken search — is caught before a request is made. The server still validates: this
 * is a courtesy, not a boundary.
 */

const CHIP = 'rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:opacity-60';
const CHIP_ON = 'border-primary bg-accent/50 font-medium';
const CHIP_OFF = 'border-border hover:bg-muted';

const SECTION = 'flex flex-col gap-3 rounded-card border border-border bg-card p-3.5';

function chipClass(active: boolean): string {
  return cn(CHIP, active ? CHIP_ON : CHIP_OFF);
}

/**
 * The interface's own value for "no constraint" in a multi-select.
 *
 * It never reaches the wire and exists in no shared vocabulary: for both the gender and
 * the place filter, "any" *is* the empty list (docs/DECISIONS.md D22/D25). The sentinel
 * exists so the neutral state can be a real, visibly pressed chip — an empty row of chips
 * reads as an unfinished form, not as a decision, and the user asked for exactly that
 * button.
 */
const ANY = 'any' as const;

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
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
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
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
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

/**
 * A fixed vocabulary offered as a dropdown, with the chosen values as removable chips.
 *
 * The languages are *not* free text: they are compared for equality between two people,
 * so "русский", "russian" and "ru" have to be one value, and the server validates against
 * the shared list. The owner asked for a dropdown rather than a row of chips
 * (docs/DECISIONS.md D22) because ten languages as buttons dominate the column; a native
 * `<select>` keeps every value discoverable and costs one line.
 */
function LanguagePicker({
  legend,
  selected,
  onToggle,
  disabled,
}: {
  legend: string;
  selected: readonly Language[];
  onToggle: (value: Language) => void;
  disabled?: boolean;
}) {
  const available = LANGUAGES.filter((language) => !selected.includes(language));

  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="text-sm font-medium">{legend}</legend>

      {selected.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((language) => (
            <li key={language}>
              <button
                type="button"
                onClick={() => onToggle(language)}
                aria-label={`Убрать ${LANGUAGE_LABELS[language]}`}
                className={cn(chipClass(true), 'flex items-center gap-1.5')}
              >
                {LANGUAGE_LABELS[language]}
                <X className="size-3.5 text-muted-foreground" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Не выбрано ни одного.</p>
      )}

      <label className="sr-only" htmlFor={`${legend}-add`}>
        Добавить язык
      </label>
      <select
        id={`${legend}-add`}
        aria-label="Добавить язык"
        className="h-9 w-full rounded-lg border border-input bg-card px-2 text-sm text-foreground disabled:opacity-50"
        value=""
        disabled={disabled || available.length === 0}
        onChange={(event) => {
          const next = event.target.value;
          if (next) onToggle(next as Language);
        }}
      >
        <option value="">Добавить язык…</option>
        {available.map((language) => (
          <option key={language} value={language}>
            {LANGUAGE_LABELS[language]}
          </option>
        ))}
      </select>
    </fieldset>
  );
}

/**
 * Adds a typed place to a filter list.
 *
 * The same spelling twice is one place, compared the way the matchmaker compares it
 * (`normalizePlace`), so a duplicate is ignored rather than shown and sent twice. A full
 * list takes nothing more: the field is disabled by then, and the server enforces the
 * same bound. Pure, so the save path can use it on a draft the user has not submitted.
 */
function addPendingPlace(list: readonly string[], draft: string): string[] {
  const value = draft.trim();

  if (value === '' || list.length >= PROFILE_LIMITS.PLACE_FILTER_MAX) return [...list];

  const folded = normalizePlace(value);
  if (folded === null || list.some((item) => normalizePlace(item) === folded)) return [...list];

  return [...list, value];
}

/**
 * A multi-select of place names: type, or pick from the same suggestions the declared
 * city and region use, then add.
 *
 * Not a `<select multiple>`: a place is free text the two people have to spell the same
 * way, not a member of a vocabulary, and the owner asked for a list with manual input —
 * the same treatment as the declared city and region, with several values (D22/D27).
 * Enter adds as well as the button, because a field with an "add" button is a form people
 * try to submit with the keyboard.
 *
 * The draft lives in the parent: "Сохранить фильтры" saves whatever is typed but not yet
 * added, so a half-finished entry can never be silently dropped.
 */
function PlacePicker({
  id,
  legend,
  values,
  draft,
  options,
  addLabel,
  placeholder,
  emptyHint,
  onDraftChange,
  onAdd,
  onRemove,
  disabled,
}: {
  id: string;
  legend: string;
  values: readonly string[];
  draft: string;
  options: readonly string[];
  addLabel: string;
  placeholder: string;
  emptyHint: string;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (value: string) => void;
  disabled?: boolean;
}) {
  const full = values.length >= PROFILE_LIMITS.PLACE_FILTER_MAX;

  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="text-sm font-medium">{legend}</legend>

      <div className="flex items-center gap-2">
        <Input
          id={id}
          aria-label={legend}
          className="min-w-0 flex-1"
          list={`${id}-suggestions`}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onAdd();
            }
          }}
          placeholder={placeholder}
          maxLength={PROFILE_LIMITS.PLACE_MAX_LENGTH}
          disabled={disabled || full}
          autoComplete="off"
        />
        <datalist id={`${id}-suggestions`}>
          {options.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          aria-label={addLabel}
          onClick={onAdd}
          disabled={disabled || full || draft.trim().length === 0}
        >
          Добавить
        </Button>
      </div>

      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <li key={value}>
              <button
                type="button"
                onClick={() => onRemove(value)}
                aria-label={`Убрать ${value}`}
                className={cn(chipClass(true), 'flex items-center gap-1.5')}
              >
                {value}
                <X className="size-3.5 text-muted-foreground" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      )}

      {full ? (
        <p className="text-xs text-muted-foreground">
          Не больше {PROFILE_LIMITS.PLACE_FILTER_MAX} названий в одном списке.
        </p>
      ) : null}
    </fieldset>
  );
}

/** Empty input means "no bound"; anything else must be a whole number. */ function parseBound(
  raw: string,
): number | null {
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

  return 'Проверьте значения: сервер отклонит такие данные.';
}

export function SettingsPanel({ session }: { session: SessionInfo }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <ProfileSection session={session} />
      <FiltersSection session={session} />
      {/*
        Spanning both columns on purpose: moderation is not half of "what the search
        knows", and putting it under one of the two would imply it belongs to that half.
      */}
      <div className="lg:col-span-2">
        <ModerationSection session={session} />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// About you
// -----------------------------------------------------------------------------

function ProfileSection({ session }: { session: SessionInfo }) {
  const [gender, setGender] = useState<Gender | null>(session.profile.gender);
  /**
   * The field the user sees is an *age*; the column is a year of birth.
   *
   * The conversion happens here, once, so the stored value never goes stale while the
   * interface keeps asking the question a person can answer without arithmetic
   * (docs/DECISIONS.md D22). Nothing else in the product knows about the difference.
   */
  const [age, setAge] = useState(
    session.profile.birthYear === null ? '' : String(ageFromBirthYear(session.profile.birthYear)),
  );
  const [city, setCity] = useState(session.profile.city ?? '');
  const [region, setRegion] = useState(session.profile.region ?? '');
  const [languages, setLanguages] = useState<Language[]>([...session.profile.languages]);

  const save = useMutation({
    mutationFn: (profile: ProfileUpdate) =>
      apiRequest<SessionView>('/me/settings', { method: 'PATCH', json: { profile } }),
    onSuccess: (updated) => {
      client.applySession(updated);
      useAppStore.getState().notify('success', 'Данные о себе сохранены.');
    },
  });

  const parsedAge = parseBound(age);
  const ageIsSane =
    parsedAge === null ||
    (Number.isInteger(parsedAge) &&
      parsedAge >= PROFILE_LIMITS.AGE_MIN + 1 &&
      parsedAge <= PROFILE_LIMITS.AGE_MAX);

  const draft = profileUpdateSchema.safeParse({
    gender,
    birthYear: parsedAge === null || !ageIsSane ? null : birthYearFromAge(parsedAge),
    // An empty field means "I no longer want to say", which is `null` on the wire.
    city: city.trim() === '' ? null : city.trim(),
    region: region.trim() === '' ? null : region.trim(),
    languages,
  });

  const canSave = ageIsSane && draft.success;

  /**
   * The one thing to say when saving is refused, in the order the user can fix them.
   *
   * Computed here rather than inside the JSX so the narrowing is on one `const`: a union
   * of "safe-parse succeeded" and "safe-parse failed" cannot be inspected inside a
   * boolean expression without a cast, and a cast would hide a real mistake later.
   */
  const problem = !ageIsSane
    ? `Возраст указывается целым числом от 1 до ${PROFILE_LIMITS.AGE_MAX}.`
    : !draft.success
      ? firstProblem(draft)
      : null;

  function toggle<T>(list: readonly T[], value: T): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  return (
    <section className={SECTION} aria-labelledby="settings-about">
      <h3 id="settings-about" className="flex items-center gap-2 text-sm font-semibold">
        <UserRound className="size-4 text-primary" aria-hidden="true" />О вас
      </h3>
      <p className="text-xs text-muted-foreground">
        Эти данные указываете вы сами, проверить их нечем. Они нужны только подбору — собеседник их
        не видит.
      </p>

      <SingleChoice
        legend="Ваш пол"
        options={[null, ...GENDERS]}
        value={gender}
        onChange={setGender}
        labelFor={(value) => (value === null ? 'Не указывать' : GENDER_LABELS[value])}
        disabled={save.isPending}
      />

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor="profile-age">
          Возраст
        </label>
        <Input
          id="profile-age"
          inputMode="numeric"
          placeholder="Например, 25"
          value={age}
          onChange={(event) => setAge(event.target.value)}
          disabled={save.isPending}
          className="w-32"
          aria-invalid={!ageIsSane}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Combobox
          id="profile-city"
          label="Город"
          value={city}
          onChange={setCity}
          options={CITY_SUGGESTIONS}
          placeholder="Начните вводить"
          maxLength={PROFILE_LIMITS.PLACE_MAX_LENGTH}
          disabled={save.isPending}
        />
        <Combobox
          id="profile-region"
          label="Регион"
          value={region}
          onChange={setRegion}
          options={REGION_SUGGESTIONS}
          placeholder="Начните вводить"
          maxLength={PROFILE_LIMITS.PLACE_MAX_LENGTH}
          disabled={save.isPending}
        />
      </div>

      <LanguagePicker
        legend="Языки, на которых вам удобно общаться"
        selected={languages}
        onToggle={(value) => setLanguages((current) => toggle(current, value))}
        disabled={save.isPending}
      />

      {problem ? (
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          {problem}
        </p>
      ) : null}

      {save.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {describeError(save.error)}
        </p>
      ) : null}

      <div>
        <Button
          disabled={!canSave || save.isPending}
          onClick={() => {
            if (draft.success) save.mutate(draft.data);
          }}
        >
          {save.isPending ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="size-4" aria-hidden="true" />
          )}
          Сохранить данные
        </Button>
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Whom to look for
// -----------------------------------------------------------------------------

function FiltersSection({ session }: { session: SessionInfo }) {
  const [genders, setGenders] = useState<Gender[]>([...session.search.genders]);
  const [ageMin, setAgeMin] = useState(boundValue(session.search.ageMin));
  const [ageMax, setAgeMax] = useState(boundValue(session.search.ageMax));
  const [cities, setCities] = useState<string[]>([...session.search.cities]);
  const [regions, setRegions] = useState<string[]>([...session.search.regions]);
  const [languages, setLanguages] = useState<Language[]>([...session.search.languages]);
  const [relaxAllowed, setRelaxAllowed] = useState(session.search.relaxAllowed);

  // The drafts live here, not inside the pickers: saving has to include what is typed
  // but not yet added, or a half-finished entry vanishes without a word.
  const [cityDraft, setCityDraft] = useState('');
  const [regionDraft, setRegionDraft] = useState('');

  const save = useMutation({
    mutationFn: (search: SearchPreferences) =>
      apiRequest<SessionView>('/me/settings', { method: 'PATCH', json: { search } }),
    onSuccess: (updated, variables) => {
      client.applySession(updated);
      setCities([...variables.cities]);
      setRegions([...variables.regions]);
      setCityDraft('');
      setRegionDraft('');
      useAppStore.getState().notify('success', 'Фильтры поиска сохранены.');
    },
  });

  const draft = searchPreferencesSchema.safeParse({
    genders,
    ageMin: parseBound(ageMin),
    ageMax: parseBound(ageMax),
    cities: addPendingPlace(cities, cityDraft),
    regions: addPendingPlace(regions, regionDraft),
    languages,
    relaxAllowed,
  });

  const preview = draft.success ? describeCriteria(draft.data) : [];
  const anywhere = cities.length === 0 && regions.length === 0;

  function toggle<T>(list: readonly T[], value: T): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  return (
    <section className={SECTION} aria-labelledby="settings-wanted">
      <h3 id="settings-wanted" className="flex items-center gap-2 text-sm font-semibold">
        <SlidersHorizontal className="size-4 text-primary" aria-hidden="true" />
        Кого искать
      </h3>
      <p className="text-xs text-muted-foreground">
        Подбор идёт только между теми, кто подходит друг другу: ваши фильтры и фильтры собеседника
        действуют одновременно.
      </p>

      <MultiChoice
        legend="Пол собеседника"
        // «Любой» is the first chip rather than an empty row: see `ANY`.
        options={[ANY, ...GENDERS]}
        selected={genders.length === 0 ? [ANY] : genders}
        onToggle={(value) => {
          if (value === ANY) setGenders([]);
          else setGenders((current) => toggle(current, value));
        }}
        labelFor={(value) => (value === ANY ? 'Любой' : GENDER_LABELS[value])}
        disabled={save.isPending}
      />

      <fieldset className="flex flex-col gap-1.5" disabled={save.isPending}>
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
      </fieldset>

      <fieldset className="flex flex-col gap-2" disabled={save.isPending}>
        <legend className="text-sm font-medium">Где искать</legend>

        {/*
          The neutral chip, the same one every other row has: «Любой» is the empty pair of
          lists, never a value on the wire (docs/DECISIONS.md D25/D27).
        */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={anywhere}
            onClick={() => {
              setCities([]);
              setRegions([]);
              setCityDraft('');
              setRegionDraft('');
            }}
            className={chipClass(anywhere)}
          >
            Любой
          </button>
          <span className="text-xs text-muted-foreground">
            {anywhere ? 'Подойдёт любой город и регион.' : 'Подойдёт любой из перечисленных.'}
          </span>
        </div>

        <PlacePicker
          id="filter-cities"
          legend="Города"
          values={cities}
          draft={cityDraft}
          options={CITY_SUGGESTIONS}
          addLabel="Добавить город"
          placeholder="Начните вводить название"
          emptyHint="Не выбран ни один город."
          onDraftChange={setCityDraft}
          onAdd={() => {
            setCities((current) => addPendingPlace(current, cityDraft));
            setCityDraft('');
          }}
          onRemove={(value) => setCities((current) => current.filter((item) => item !== value))}
          disabled={save.isPending}
        />

        <PlacePicker
          id="filter-regions"
          legend="Регионы"
          values={regions}
          draft={regionDraft}
          options={REGION_SUGGESTIONS}
          addLabel="Добавить регион"
          placeholder="Начните вводить название"
          emptyHint="Не выбран ни один регион."
          onDraftChange={setRegionDraft}
          onAdd={() => {
            setRegions((current) => addPendingPlace(current, regionDraft));
            setRegionDraft('');
          }}
          onRemove={(value) => setRegions((current) => current.filter((item) => item !== value))}
          disabled={save.isPending}
        />
      </fieldset>

      <LanguagePicker
        legend="Общий язык"
        selected={languages}
        onToggle={(value) => setLanguages((current) => toggle(current, value))}
        disabled={save.isPending}
      />

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Если подходящего собеседника долго нет</span>
        {/*
          The button's name is the *setting*, never its current value: a toggle whose label
          flips between "Ничего не снимать" and "Разрешить снимать фильтры по одному" reads
          as an instruction and does the opposite of what it says when it is already on. The
          value is carried by `aria-pressed` and by the words next to it, which is also what
          a screen reader announces.
        */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={relaxAllowed}
            disabled={save.isPending}
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
          Снятие никогда не происходит молча: сервер сообщит, какой фильтр снят.
        </p>
      </div>

      <div className="rounded-lg border border-border p-2.5">
        <p className="section-label">Будет применяться</p>
        {preview.length === 0 ? (
          <p className="mt-1 text-sm">Без фильтров — подойдёт любой собеседник.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5 text-sm">
            {preview.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </div>

      {!draft.success ? (
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          {firstProblem(draft)}
        </p>
      ) : null}

      {save.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {describeError(save.error)}
        </p>
      ) : null}

      <div>
        <Button
          disabled={!draft.success || save.isPending}
          onClick={() => {
            if (draft.success) save.mutate(draft.data);
          }}
        >
          {save.isPending ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="size-4" aria-hidden="true" />
          )}
          Сохранить фильтры
        </Button>
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Moderation
// -----------------------------------------------------------------------------

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

function ModerationSection({ session }: { session: SessionInfo }) {
  const queryClient = useQueryClient();

  const updateSetting = useMutation({
    mutationFn: (patch: { incomingRequests?: IncomingRequestPolicy; blockingEnabled?: boolean }) =>
      apiRequest<SessionView>('/me/settings', { method: 'PATCH', json: patch }),
    onSuccess: (updated) => {
      // The response nests everything under `settings`. Reading a field flat left the
      // toggle showing the *old* value until the page was reloaded: the setting was saved,
      // but the screen said otherwise.
      client.applySession(updated);
    },
  });

  const blockingEnabled = session.blockingEnabled;

  const blocks = useQuery({
    queryKey: ['blocks'],
    queryFn: () => apiRequest<BlockListResponse>('/blocks'),
    staleTime: 10_000,
    // Nothing to show while the feature is off — and no reason to ask.
    enabled: blockingEnabled,
  });

  const unblock = useMutation({
    mutationFn: (publicId: string) =>
      apiRequest<{ removed: boolean }>(`/blocks/${publicId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['blocks'] });
    },
  });

  return (
    <section className={SECTION} aria-labelledby="settings-moderation">
      <h3 id="settings-moderation" className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
        Модерация
      </h3>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Входящие заявки</span>
        <div className="grid gap-2 sm:grid-cols-2">
          {POLICY_OPTIONS.map((option) => {
            const selected = session.incomingRequests === option.value;

            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                disabled={updateSetting.isPending}
                onClick={() => updateSetting.mutate({ incomingRequests: option.value })}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-lg border p-2.5 text-left transition-colors disabled:opacity-60',
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
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        <span className="text-sm font-medium">Блокировка собеседника</span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={blockingEnabled}
            disabled={updateSetting.isPending}
            onClick={() => updateSetting.mutate({ blockingEnabled: !blockingEnabled })}
            className={chipClass(blockingEnabled)}
          >
            Блокировать собеседников
          </button>
          <span className="text-sm text-muted-foreground">
            {blockingEnabled ? 'Включена' : 'Выключена'}
          </span>
        </div>
        {/*
          The honest consequence, in one sentence: switching the feature off is not the
          same as lifting the blocks you already made, and it must not silently become
          that. Whoever was blocked stays blocked, and turning the feature back on brings
          the list back so it can be undone.
        */}
        <p className="text-xs text-muted-foreground">
          Выключенная блокировка убирает кнопку в чате и этот список. Ранее заблокированные остаются
          заблокированными — включите обратно, чтобы их увидеть.
        </p>
      </div>

      {blockingEnabled ? (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <span className="text-sm font-medium">Заблокированные</span>

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
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2.5"
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
                ) : (
                  <Ban className="size-4" aria-hidden="true" />
                )}
                Разблокировать
              </Button>
            </div>
          ))}

          {unblock.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {describeError(unblock.error)}
            </p>
          ) : null}
        </div>
      ) : null}

      {updateSetting.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {describeError(updateSetting.error)}
        </p>
      ) : null}
    </section>
  );
}

/** Placeholder used while the settings load. */
export function SettingsSkeleton() {
  return (
    <div className="grid gap-3 lg:grid-cols-2" aria-busy="true" aria-label="Загружаем настройки">
      <Skeleton className="h-64 w-full rounded-card" />
      <Skeleton className="h-64 w-full rounded-card" />
    </div>
  );
}
