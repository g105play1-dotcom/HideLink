import { ErrorCode } from '@anonlink/shared';

import { API_BASE, API_UNREACHABLE_HINT } from './config';

/**
 * A failed API call.
 *
 * `code` is the stable contract from `@anonlink/shared`; `message` is the server's
 * (English) prose. The UI renders its own Russian text keyed by `code` and only
 * falls back to `message` for codes it does not know — so wording changes on the
 * server can never produce an untranslated UI.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly context?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the API could not be reached at all (offline, not started, CORS). */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; context?: string };
}

function isErrorCode(value: string | undefined): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ErrorCode, value);
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Serialised as JSON. Omit for bodyless requests. */
  json?: unknown;
  /** Abort after this many milliseconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Calls the API.
 *
 * Every request sends cookies (`credentials: 'include'`) because the anonymous
 * session lives in an `HttpOnly` cookie the JavaScript side must never touch.
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = 'GET', json, timeoutMs = 10_000, signal } = options;

  // Combine the caller's signal with our own timeout so neither can be ignored.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      signal: controller.signal,
    });
  } catch (error) {
    // A thrown `fetch` means the request never reached the API: offline, the API
    // is not running, or CORS blocked it. Reported as "service unavailable" rather
    // than as a bug in the request.
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new ApiError(
      ErrorCode.DATABASE_UNAVAILABLE,
      aborted ? 'Превышено время ожидания ответа сервера.' : API_UNREACHABLE_HINT,
      0,
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body: unknown = text ? safeJsonParse(text) : undefined;

  if (!response.ok) {
    const parsed = (body ?? {}) as ErrorBody;
    const code = isErrorCode(parsed.error?.code) ? parsed.error.code : ErrorCode.INTERNAL_ERROR;
    throw new ApiError(
      code,
      parsed.error?.message ?? 'Request failed.',
      response.status,
      parsed.error?.context,
    );
  }

  return body as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
