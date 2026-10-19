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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="antialiased">
        {/* Real, working skip link — the first focusable element on the page. */}
        <a href="#main" className="sr-only-focusable">
          Перейти к основному содержимому
        </a>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
