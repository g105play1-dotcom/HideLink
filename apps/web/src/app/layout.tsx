import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { AppProviders } from '@/components/app-providers';

import './globals.css';

export const metadata: Metadata = {
  title: 'AnonLink — анонимный чат',
  description:
    'Анонимный чат один на один: случайный собеседник или чат по User ID. Без регистрации, почты и телефона.',
  applicationName: 'AnonLink',
};

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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="antialiased">
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* Real, working skip link — the first focusable element on the page. */}
        <a href="#main" className="sr-only-focusable">
          Перейти к основному содержимому
        </a>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
