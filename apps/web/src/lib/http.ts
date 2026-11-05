import { ErrorCode } from '@anonlink/shared';

import { activeT } from '@/i18n';

import { API_BASE } from './config';

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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Serialised as JSON. Omit for bodyless requests. */
  json?: unknown;
  /** Raw request body, used by the attachment upload. Takes precedence over `json`. */
  body?: BodyInit;
  /** `Content-Type` for a raw body. */
  contentType?: string;
  /** Abort after this many milliseconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface FetchOptions extends ApiRequestOptions {
  accept: string;
}

/**
 * Calls the API.
 *
 * Every request sends cookies (`credentials: 'include'`) because the anonymous
 * session lives in an `HttpOnly` cookie the JavaScript side must never touch.
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const response = await apiFetch(path, { ...options, accept: 'application/json' });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body: unknown = text ? safeJsonParse(text) : undefined;

  if (!response.ok) throw toApiError(body, response.status);

  return body as T;
}

/**
 * Fetches attachment bytes.
 *
 * A separate function because `apiRequest` parses JSON, and an attachment response is
 * binary. The error path still reads the JSON error envelope, so a missing or forbidden
 * attachment reaches the UI as a normal `ApiError` (and a Russian message), not as a
 * broken image.
 */
export async function apiBlob(path: string, options: ApiRequestOptions = {}): Promise<Blob> {
  const response = await apiFetch(path, {
    ...options,
    accept: '*/*',
    timeoutMs: options.timeoutMs ?? 30_000,
  });

  if (!response.ok) {
    const text = await response.text();
    throw toApiError(text ? safeJsonParse(text) : undefined, response.status);
  }

  return response.blob();
}

async function apiFetch(path: string, options: FetchOptions): Promise<Response> {
  const { method = 'GET', json, body, contentType, timeoutMs = 10_000, signal, accept } = options;

  // Combine the caller's signal with our own timeout so neither can be ignored.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  const requestBody = json !== undefined ? JSON.stringify(json) : body;
  const requestContentType =
    json !== undefined ? 'application/json' : requestBody === undefined ? undefined : contentType;

  try {
    return await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers: {
        accept,
        ...(requestContentType ? { 'content-type': requestContentType } : {}),
      },
      ...(requestBody === undefined ? {} : { body: requestBody }),
      signal: controller.signal,
    });
  } catch (error) {
    // A thrown `fetch` means the request never reached the API: offline, the API
    // is not running, or CORS blocked it. Reported as "service unavailable" rather
    // than as a bug in the request.
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new ApiError(
      ErrorCode.DATABASE_UNAVAILABLE,
      aborted
        ? activeT('Превышено время ожидания ответа сервера.')
        : activeT(
            'Не удаётся связаться с сервером. Проверьте, что API запущен, и попробуйте снова.',
          ),
      0,
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function toApiError(body: unknown, status: number): ApiError {
  const parsed = (body ?? {}) as ErrorBody;
  const code = isErrorCode(parsed.error?.code) ? parsed.error.code : ErrorCode.INTERNAL_ERROR;
  return new ApiError(
    code,
    parsed.error?.message ?? 'Request failed.',
    status,
    parsed.error?.context,
  );
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
