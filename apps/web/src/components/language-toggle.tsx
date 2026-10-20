'use client';

import { Globe } from 'lucide-react';

import { LOCALE_NAMES, LOCALES, isLocale } from '@/i18n/config';
import { useI18n } from '@/i18n';

/**
 * The interface-language switch, beside the theme switch.
 *
 * A native `<select>` rather than a menu: three values, no dependency, keyboard
 * and screen-reader behaviour for free, and the chosen value is the language's own
 * name — «Русский», "English", «中文» — which is what a person looking for their
 * language recognises. The names are marked `translate="no"`: a browser translator
 * must not translate the list of languages into the language being chosen.
 *
 * The switch changes the text immediately and writes the cookie the server reads
 * for `<html lang>` and the page title; the next request renders in the same
 * language, so there is no flash of the old one on reload.
 */
export function LanguageToggle() {
  const { locale, setLocale, t } = useI18n();

  return (
    <label className="relative flex items-center">
      <span className="sr-only">{t('Язык интерфейса')}</span>
      <Globe
        className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
        aria-hidden="true"
      />
      <select
        translate="no"
        value={locale}
        onChange={(event) => {
          const next = event.target.value;
          if (isLocale(next)) setLocale(next);
        }}
        aria-label={t('Язык интерфейса')}
        title={t('Язык интерфейса')}
        className="h-9 rounded-lg border border-border bg-transparent pr-1.5 pl-7 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        {LOCALES.map((value) => (
          <option key={value} value={value}>
            {LOCALE_NAMES[value]}
          </option>
        ))}
      </select>
    </label>
  );
}
