/**
 * Date/time helpers.
 *
 * All timestamps on the wire are ISO-8601 UTC; they are rendered in the viewer's
 * own locale and time zone, which is the only representation that is unambiguous
 * to them.
 */

const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
});

const dateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** `14:05` — used for message timestamps. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : timeFormatter.format(date);
}

/** `18 окт., 14:05` — used for the identity creation date. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateTimeFormatter.format(date);
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
export function formatRemaining(untilIso: string, now: number = Date.now()): string {
  const until = new Date(untilIso).getTime();
  if (Number.isNaN(until)) return '';

  const seconds = Math.max(0, Math.round((until - now) / 1000));
  return `${seconds} с`;
}
