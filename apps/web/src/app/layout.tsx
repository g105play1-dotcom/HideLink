import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { AppProviders } from '@/components/app-providers';
import { SkipLink } from '@/components/skip-link';
import { I18nProvider } from '@/i18n';
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from '@/i18n/config';
import { SITE_META } from '@/i18n/site';

import './globals.css';

/**
 * The language the server renders in.
 *
 * Only the cookie is consulted: the owner's rule is Russian by default, and the
 * browser's `Accept-Language` must not override that. Reading a cookie makes the
 * route dynamic, which is the honest cost of server-rendered `<html lang>` and
 * language-specific metadata — a static shell would have to guess.
 */
async function currentLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export async function generateMetadata(): Promise<Metadata> {
  const locale = await currentLocale();

  return {
    title: SITE_META[locale].title,
    description: SITE_META[locale].description,
    applicationName: 'AnonLink',
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfd' },
    { media: '(prefers-color-scheme: dark)', color: '#12161f' },
  ],
};

/**
 * Applies the theme before the first paint.
 *
 * Inline and synchronous on purpose: anything asynchronous (a hook, an effect, a
 * component that renders the class) runs *after* the browser has already painted, which
 * is exactly the white flash a dark-theme user would see on every load. The literals here
 * must match `lib/theme.ts` (`anonlink.theme`, `dark`).
 */
const THEME_SCRIPT = `(function(){try{var s=localStorage.getItem('anonlink.theme');var d=s==='dark'||(s!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await currentLocale();

  return (
    // The inline theme script below sets `class`/`style` on <html> before React hydrates,
    // which is intentional (no white flash). Suppress the resulting attribute warning
    // instead of letting the dev overlay report a mismatch on every load.
    <html lang={locale} suppressHydrationWarning>
      <body className="antialiased">
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* Real, working skip link — the first focusable element on the page. */}
        <I18nProvider initialLocale={locale}>
          <SkipLink />
          <AppProviders>{children}</AppProviders>
        </I18nProvider>
      </body>
    </html>
  );
}
