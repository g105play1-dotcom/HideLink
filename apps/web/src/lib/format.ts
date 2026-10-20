import { DEFAULT_LOCALE, LOCALE_TAGS, type Locale } from '@/i18n/config';
import { translate } from '@/i18n/messages';

/**
 * Date/time helpers.
 *
 * All timestamps on the wire are ISO-8601 UTC; they are rendered in the viewer's
 * own time zone, in the chosen interface language. The time zone is deliberately
 * the browser's: the clock on messages is what the reader's clock says, not the
 * server's.
 */
const timeFormatters = new Map<Locale, Intl.DateTimeFormat>();
const dateTimeFormatters = new Map<Locale, Intl.DateTimeFormat>();

function timeFormatter(locale: Locale): Intl.DateTimeFormat {
  let formatter = timeFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
      hour: '2-digit',
      minute: '2-digit',
    });
    timeFormatters.set(locale, formatter);
  }
  return formatter;
}

function dateTimeFormatter(locale: Locale): Intl.DateTimeFormat {
  let formatter = dateTimeFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    dateTimeFormatters.set(locale, formatter);
  }
  return formatter;
}

/** `14:05` — used for message timestamps. */
export function formatTime(iso: string, locale: Locale = DEFAULT_LOCALE): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : timeFormatter(locale).format(date);
}

/** `18 окт., 14:05` — used for the identity creation date. */
export function formatDateTime(iso: string, locale: Locale = DEFAULT_LOCALE): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateTimeFormatter(locale).format(date);
}

/** `03:12` — how long an operation has been running. */
export function formatElapsed(fromIso: string, now: number = Date.now()): string {
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) return '00:00';

  const totalSeconds = Math.max(0, Math.floor((now - from) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** `через 42 с` — used for request expiry. */
export function formatRemaining(
  untilIso: string,
  now: number = Date.now(),
  locale: Locale = DEFAULT_LOCALE,
): string {
  const until = new Date(untilIso).getTime();
  if (Number.isNaN(until)) return '';

  const seconds = Math.max(0, Math.round((until - now) / 1000));
  return translate(locale, '{seconds} с', { seconds });
}
