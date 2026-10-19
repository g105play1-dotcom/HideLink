import { type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType } from 'zod';

/**
 * Validates and transforms a handler argument with a Zod schema.
 *
 * The same schema objects from `@anonlink/shared` are used by the browser, by the
 * REST API and by the gateway, so the rules can never drift apart. Failures surface
 * as a `ZodError`, which the global filter turns into a `400 INVALID_INPUT`
 * response that never echoes the offending value back to the client.
 */

/** Where a validated value came from. Used only to label validation errors. */
export type ValidationSource = 'body' | 'param' | 'query';

export class ZodValidationPipe<TOut = unknown> implements PipeTransform<unknown, TOut> {
  constructor(
    private readonly schema: ZodType<TOut>,
    private readonly source: ValidationSource = 'body',
  ) {}

  transform(value: unknown): TOut {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      // Zod knows the path *inside* the value but not whether the value arrived as a
      // request body, a path parameter or a query string. Prefixing the source turns
      // an opaque "Invalid input" into "param.publicId: Invalid input" — the difference
      // between a one-minute fix and a long hunt through three schemas.
      throw new ZodError(
        result.error.issues.map((issue) => ({
          ...issue,
          path: [this.source, ...issue.path],
        })) as typeof result.error.issues,
      );
    }

    return result.data;
  }
}

export const zodBody = <TOut>(schema: ZodType<TOut>): ZodValidationPipe<TOut> =>
  new ZodValidationPipe(schema, 'body');

export const zodParam = <TOut>(schema: ZodType<TOut>): ZodValidationPipe<TOut> =>
  new ZodValidationPipe(schema, 'param');

export const zodQuery = <TOut>(schema: ZodType<TOut>): ZodValidationPipe<TOut> =>
  new ZodValidationPipe(schema, 'query');
