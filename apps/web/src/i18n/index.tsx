'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { DEFAULT_LOCALE, LOCALE_TAGS, persistLocale, type Locale } from './config';
import { translate, type MessageKey } from './messages';

/**
 * The interface language, on the client.
 *
 * The server reads the cookie and renders `<html lang>` and metadata (see
 * `app/layout.tsx`); this provider is the browser half: it keeps the chosen
 * language in React state, writes both the cookie and `localStorage`, and updates
 * `document.documentElement.lang` immediately so the page's declared language
 * never disagrees with the visible interface.
 *
 * A module-level mirror exists because the socket client and the store create
 * messages outside React (`anonymous-client.ts`, `app-store.ts`). They call
 * `activeT`, which is the same dictionary with the current locale. Those strings
 * are snapshots: a notice created in Russian stays Russian if the language changes
 * while it is on screen, which is acceptable for seven-second feedback and wrong
 * for anything durable — durable text is rendered from a key instead.
 */
interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

let activeLocale: Locale = DEFAULT_LOCALE;

/**
 * Set by the owner's page, which is Russian-only (D32).
 *
 * The provider's own effect runs *after* a child's effect, so an override that only
 * assigned `document.documentElement.lang` would be undone a moment later when the
 * provider applied the cookie's locale. The mirror lives here so both writers agree.
 */
let htmlLangOverride: Locale | null = null;

export function getActiveLocale(): Locale {
  return activeLocale;
}

/** The `Intl` tag for the active language (dates, numbers, list conjunctions). */
export function activeIntlTag(): string {
  return LOCALE_TAGS[activeLocale];
}

export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = htmlLangOverride ?? locale;
  }
}

/**
 * Declares the document's language for one screen, ignoring the chosen interface
 * language until cleared (`null`). Used by `/admin`, which must stay Russian.
 */
export function setHtmlLangOverride(locale: Locale | null): void {
  htmlLangOverride = locale;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale ?? activeLocale;
  }
}

/** Translation for code that runs outside a React component. */
export function activeT(key: MessageKey, values?: Record<string, string | number>): string {
  return translate(activeLocale, key, values);
}

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    // Runs during render on both sides. Only the module-level mirror is assigned
    // here; the DOM and the cookie are touched in the effect below, because render
    // must stay free of side effects.
    activeLocale = initialLocale;
    return initialLocale;
  });

  useEffect(() => {
    setActiveLocale(locale);
    persistLocale(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setActiveLocale(next);
    setLocaleState(next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, values) => translate(locale, key, values),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) {
    throw new Error('useI18n must be used inside I18nProvider');
  }
  return value;
}
