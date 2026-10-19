import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ErrorCode, errorMessage } from '@anonlink/shared';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';

import { AppError } from './app-error.js';
import { log } from './logger.js';

/**
 * The single HTTP error boundary.
 *
 * Guarantees:
 *  - every response body has the same shape: `{ error: { code, message, context? } }`;
 *  - only {@link AppError} (and explicit `HttpException`s) may influence the status
 *    code and message, so internal failures cannot leak stack traces, SQL or paths;
 *  - unexpected failures are logged with a correlation id that is also returned to
 *    the client, so a user can report "error abc123" without exposing details.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, payload, retryAfterMs } = this.describe(exception, request);

    if (retryAfterMs !== undefined) {
      response.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    }

    response.status(status).json({ error: payload });
  }

  private describe(
    exception: unknown,
    request: Request,
  ): {
    status: number;
    payload: { code: string; message: string; context?: string; correlationId?: string };
    retryAfterMs?: number;
  } {
    if (exception instanceof AppError) {
      let retryAfterMs: number | undefined;
      if (exception.code === ErrorCode.RATE_LIMITED && exception.context) {
        const match = /retry-after-ms:(\d+)/.exec(exception.context);
        if (match?.[1]) retryAfterMs = Number(match[1]);
        // The raw context is an implementation detail; it is reported separately.
        return {
          status: exception.httpStatus,
          payload: { code: exception.code, message: exception.message },
          retryAfterMs,
        };
      }
      return { status: exception.httpStatus, payload: exception.toPayload() };
    }

    if (exception instanceof ZodError) {
      const first = exception.issues[0];
      // `path[0]` is the source label the validation pipe added (`body`, `param`,
      // `query`), so this reads e.g. `body.incomingRequests: Unrecognized key`.
      return {
        status: HttpStatus.BAD_REQUEST,
        payload: {
          code: ErrorCode.INVALID_INPUT,
          message: errorMessage(ErrorCode.INVALID_INPUT),
          context: first ? `${first.path.join('.') || 'input'}: ${first.message}` : undefined,
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // Nest's own exceptions — an unknown route, an oversized body, a malformed JSON
      // payload — are mapped onto our own codes, so *every* response a client can see
      // is expressible in `ErrorCode` and none of them echo Nest's wording.
      const code =
        status === HttpStatus.NOT_FOUND
          ? ErrorCode.ROUTE_NOT_FOUND
          : status === HttpStatus.PAYLOAD_TOO_LARGE
            ? ErrorCode.PAYLOAD_TOO_LARGE
            : status === HttpStatus.TOO_MANY_REQUESTS
              ? ErrorCode.RATE_LIMITED
              : ErrorCode.INVALID_INPUT;

      return { status, payload: { code, message: errorMessage(code) } };
    }

    // Anything else is a bug. Log it fully server-side, tell the client nothing.
    const correlationId = Math.random().toString(36).slice(2, 10);
    log.error('http.unhandled_error', exception, {
      correlationId,
      method: request.method,
      route: request.route?.path ?? request.path,
    });

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      payload: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Something went wrong. Please try again.',
        correlationId,
      },
    };
  }
}
