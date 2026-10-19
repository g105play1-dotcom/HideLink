'use client';

import { useSyncExternalStore } from 'react';

/**
 * The interface theme: light, dark, or whatever the operating system says.
 *
 * ## Why this is not React state
 *
 * The theme is an *external system*: the class on `<html>` is what actually paints the
 * page, and a second copy of the value inside a component could disagree with it. It is
 * kept in a module-level store and read with `useSyncExternalStore`, the same shape as
 * `use-ticker.ts`, which also sidesteps the React 19 rule against writing state from an
 * effect body.
 *
 * ## Three states, two buttons
 *
 * `null` means "nobody has chosen": the operating system decides, and it keeps deciding
 * if the user never touches the switch. Pressing the switch stores an explicit `light` or
 * `dark`, after which the system preference is ignored — a user who picked a theme does
 * not want it changed under them at sunset.
 *
 * ## Why the first paint is already correct
 *
 * `layout.tsx` runs a tiny inline script before the body renders, so the class is set
 * before anything is painted. Without it, a dark-theme user would see a flash of white on
 * every navigation. This module and that script must agree on the storage key and the
 * class name; both are defined here and the script only repeats the literal.
 */

export type Theme = 'light' | 'dark';

/** Must match the key used by the inline script in `layout.tsx`. */
export const THEME_STORAGE_KEY = 'anonlink.theme';

/** Must match the class toggled by the inline script in `layout.tsx`. */
export const DARK_CLASS = 'dark';

const listeners = new Set<() => void>();

/** `null` until resolved; also what tells us the store has been read at least once. */
let cached: Theme | null = null;
let mediaQuery: MediaQueryList | null = null;

function systemTheme(): Theme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * The user's stored choice, when it is readable.
 *
 * Reading `localStorage` can throw: some browsers refuse it in a partitioned or
 * third-party context, and the theme must not become a reason the app does not boot.
 */
export function readStoredTheme(): Theme | null {
  if (typeof window === 'undefined') return null;

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

/** Paints a theme. The only place the DOM is touched. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(DARK_CLASS, theme === 'dark');
  // Keeps native widgets (scrollbars, form controls) in step with the page.
  document.documentElement.style.colorScheme = theme;
}

function currentTheme(): Theme {
  if (cached === null) cached = readStoredTheme() ?? systemTheme();
  return cached;
}

/** Switches the theme, remembers the choice and repaints. */
export function setTheme(theme: Theme): void {
  cached = theme;
  applyTheme(theme);

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A refused write means the choice lasts for this page view only. Still better than
    // throwing and leaving the page half-updated.
  }

  for (const listener of [...listeners]) listener();
}

function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);

  if (mediaQuery === null && typeof window !== 'undefined') {
    // Attached once, for the lifetime of the page, and only useful while nothing has been
    // chosen: after an explicit choice the system preference is deliberately ignored, and
    // following it would fight the user. A system theme change matters only when the user
    // is *following* the system.
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', () => {
      if (readStoredTheme() !== null) return;
      const next = query.matches ? 'dark' : 'light';
      if (next === cached) return;
      cached = next;
      applyTheme(next);
      for (const current of [...listeners]) current();
    });
    mediaQuery = query;
  }

  return () => {
    // The subscription set only decides *who is told*; the media listener above is
    // deliberately permanent, so a component that unmounts and remounts (a dialog, a
    // route change) does not detach and re-attach it and lose an event in between.
    listeners.delete(listener);
  };
}

const getServerSnapshot = (): Theme => 'light';

/**
 * The current theme, and a way to change it.
 *
 * The server snapshot is a constant: the server has no idea what the user prefers, and
 * the inline script has already painted the right colours. React re-reads the client
 * value immediately after hydration.
 */
export function useTheme(): [Theme, (theme: Theme) => void] {
  // `subscribeTheme` is a module-level function, so it is already stable across renders —
  // wrapping it in a callback would only add a dependency to explain.
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, getServerSnapshot);

  return [theme, setTheme];
}
