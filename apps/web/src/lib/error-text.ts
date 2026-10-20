import type { ChatEndReason, ErrorCode, ReportReason } from '@anonlink/shared';
import type { MatchCancelReason, RequestStatus } from '@anonlink/protocol';

import { DEFAULT_LOCALE, type Locale } from '@/i18n/config';
import { translate, type MessageKey } from '@/i18n/messages';

/**
 * User-facing text, keyed by the *stable* machine-readable contract.
 *
 * The server also sends an English `message`, but the UI never shows it for a code
 * it knows: wording on the server can then change without leaving half-translated
 * copy in the browser, and a compromised/mismatched server cannot inject arbitrary
 * text into the interface.
 *
 * The second argument is the interface language. It defaults to Russian, which is
 * what `/admin` needs: the owner's page is Russian-only even when the public
 * interface is English or Chinese, and it must not inherit the module-level
 * language of whichever tab happens to be open.
 */
const ERROR_TEXT: Record<ErrorCode, MessageKey> = {
  INVALID_INPUT: 'Некорректные данные. Проверьте ввод.',
  IDENTITY_REQUIRED: 'Нужна анонимная сессия. Обновите страницу.',
  IDENTITY_NOT_FOUND: 'Сессия больше не действительна. Обновите страницу.',
  IDENTITY_BANNED: 'Эта анонимная личность заблокирована.',
  USER_NOT_FOUND: 'Пользователь с таким User ID не найден.',
  USER_UNAVAILABLE: 'Этот пользователь сейчас недоступен.',
  SELF_TARGET_NOT_ALLOWED: 'Нельзя написать самому себе.',
  ALREADY_IN_CHAT: 'Вы уже в чате.',
  CHAT_NOT_FOUND: 'Этот чат больше не существует.',
  NOT_A_PARTICIPANT: 'Вы не участник этого чата.',
  CHAT_ENDED: 'Чат завершён.',
  MESSAGE_TOO_LONG: 'Сообщение слишком длинное.',
  MESSAGE_EMPTY: 'Сообщение пустое.',
  RATE_LIMITED: 'Слишком много запросов. Подождите немного.',
  TOO_MANY_CONNECTIONS: 'Слишком много открытых вкладок для этой личности.',
  REQUEST_NOT_FOUND: 'Заявка больше не существует.',
  REQUEST_EXPIRED: 'Время заявки истекло.',
  REQUEST_DECLINED: 'Заявка отклонена.',
  INCOMING_REQUESTS_DISABLED: 'Этот пользователь не принимает заявки.',
  BLOCKED: 'Общение с этим пользователем невозможно.',
  BLOCKING_DISABLED: 'Блокировка сейчас отключена администрацией.',
  REPORT_NOT_FOUND: 'Эта жалоба больше не существует.',
  UNSUPPORTED_EVENT: 'Неподдерживаемое событие. Обновите страницу.',
  ADMIN_AUTH_REQUIRED: 'Неверный ключ владельца.',
  FORBIDDEN_ORIGIN: 'Этот источник не может подключиться.',
  ROUTE_NOT_FOUND: 'Такого адреса на сервере нет. Обновите страницу.',
  PAYLOAD_TOO_LARGE: 'Запрос слишком большой.',
  INTERNAL_ERROR: 'Что-то пошло не так. Попробуйте ещё раз.',
  DATABASE_UNAVAILABLE: 'Сервис временно недоступен.',
};

const FALLBACK_ERROR: MessageKey = 'Что-то пошло не так. Попробуйте ещё раз.';

/**
 * Looks up text for an error code, tolerating codes this build predates.
 *
 * Accepts `unknown` so it can be handed anything that was thrown — an `ApiError`, a
 * plain `Error`, or a React Query error — without a cast at every call site.
 */
export function describeError(error: unknown, locale: Locale = DEFAULT_LOCALE): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };

    if (typeof candidate.code === 'string') {
      const known = (ERROR_TEXT as Record<string, MessageKey | undefined>)[candidate.code];
      if (known) return translate(locale, known);
    }

    if (typeof candidate.message === 'string' && candidate.message.length > 0) {
      return candidate.message;
    }
  }

  return translate(locale, FALLBACK_ERROR);
}

const CHAT_END_TEXT: Record<ChatEndReason, MessageKey> = {
  left: 'Вы завершили чат.',
  peer_left: 'Собеседник завершил чат.',
  disconnected: 'Собеседник отключился и не вернулся.',
  blocked: 'Вы заблокировали собеседника. Чат завершён.',
  reported: 'Жалоба отправлена. Чат завершён.',
  server_shutdown: 'Сервис был перезапущен, поэтому чат завершён.',
  expired: 'Чат завершён по истечении времени.',
};

export function describeChatEnd(reason: ChatEndReason, locale: Locale = DEFAULT_LOCALE): string {
  return translate(locale, CHAT_END_TEXT[reason] ?? 'Чат завершён.');
}

const REQUEST_STATUS_TEXT: Record<RequestStatus, MessageKey> = {
  accepted: 'Заявка принята — чат начался.',
  declined: 'Заявка отклонена.',
  expired: 'Время заявки истекло.',
  cancelled: 'Заявка отменена.',
  unavailable: 'Пользователь сейчас недоступен.',
  blocked: 'Общение с этим пользователем невозможно.',
  disabled: 'Пользователь не принимает заявки.',
  self: 'Это ваш собственный User ID.',
};

export function describeRequestStatus(
  status: RequestStatus,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return translate(locale, REQUEST_STATUS_TEXT[status] ?? 'Заявка обработана.');
}

const MATCH_CANCEL_TEXT: Record<MatchCancelReason, MessageKey> = {
  user: 'Поиск отменён.',
  timeout: 'Поиск остановлен: слишком долго никто не находился.',
  chat_started: 'Собеседник найден.',
};

export function describeMatchCancel(
  reason: MatchCancelReason,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return translate(locale, MATCH_CANCEL_TEXT[reason] ?? 'Поиск остановлен.');
}

/** Reason labels offered in the report dialog, in the order they are shown. */
export const REPORT_REASON_LABELS: Record<ReportReason, MessageKey> = {
  spam: 'Спам или реклама',
  abuse: 'Оскорбления или травля',
  sexual: 'Неприемлемый контент',
  violence: 'Угрозы или насилие',
  other: 'Другое',
};
