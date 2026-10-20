'use client';

import { useI18n } from '@/i18n';

/**
 * The first focusable element on the page.
 *
 * A client component only because its text follows the interface language; the
 * link itself is a plain anchor and works before hydration.
 */
export function SkipLink() {
  const { t } = useI18n();

  return (
    <a href="#main" className="sr-only-focusable">
      {t('Перейти к основному содержимому')}
    </a>
  );
}
