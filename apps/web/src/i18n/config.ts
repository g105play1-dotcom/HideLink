/**
 * Interface locales.
 *
 * The owner asked for Russian, English and Chinese, a switch next to the theme
 * switch, native names in that switch and **Russian by default** — the browser's
 * `Accept-Language` is deliberately not consulted. A person who opens the site on
 * a Chinese laptop gets the Russian interface until they choose otherwise, which
 * is what "default Russian" means (D32).
 *
 * The list is a tuple, so `Locale` is a union and every `Record<Locale, …>` below
 * becomes an exhaustiveness check: adding a language here fails the build until
 * its name, its `Intl` tag and its dictionary exist.
 */
export const LOCALES = ['ru', 'en', 'zh'] as const;

export type Locale = (typeof LOCALES)[number];

/** The shipped default, and the interface of `/admin` regardless of the cookie. */
export const DEFAULT_LOCALE: Locale = 'ru';

/** Cookie the server reads for `<html lang>` and metadata. Not a secret: no `HttpOnly`. */
export const LOCALE_COOKIE = 'anonlink.locale';

/** Same value in `localStorage`, for the case where cookies are blocked. */
export const LOCALE_STORAGE = 'anonlink.locale';

/**
 * Native names, never translated.
 *
 * «Русский» stays «Русский» in the Chinese interface: that is the spelling a
 * Russian speaker recognises, and translating language names is how people fail
 * to find their own language in a list. The same rule already governs language
 * *tags* in the profile (`lib/labels.ts`).
 */
export const LOCALE_NAMES: Record<Locale, string> = {
  ru: 'Русский',
  en: 'English',
  zh: '中文',
};

/** `Intl` tags, used for dates, numbers and list conjunctions. */
export const LOCALE_TAGS: Record<Locale, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  zh: 'zh-CN',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Best-effort read of a cookie without `document.cookie` parsing at every call.
 * Returns `null` outside a browser and for an unknown value.
 */
export function readLocaleCookie(): Locale | null {
  if (typeof document === 'undefined') return null;

  const prefix = `${LOCALE_COOKIE}=`;
  const found = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  if (!found) return null;
  const value = decodeURIComponent(found.slice(prefix.length));
  return isLocale(value) ? value : null;
}

export function readStoredLocale(): Locale | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE);
    return isLocale(value) ? value : null;
  } catch {
    // Storage can throw when the browser blocks it; the cookie is the primary path.
    return null;
  }
}

/** Persists the choice in both places, as the owner asked. */
export function persistLocale(locale: Locale): void {
  if (typeof document === 'undefined') return;

  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
  try {
    window.localStorage.setItem(LOCALE_STORAGE, locale);
  } catch {
    // Blocked storage is not a reason to keep the old language on screen.
  }
}
