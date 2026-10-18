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
export class ZodValidationPipe<TOut = unknown> implements PipeTransform<unknown, TOut> {
  constructor(private readonly schema: ZodType<TOut>) {}

  transform(value: unknown): TOut {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new ZodError(result.error.issues);
    return result.data;
  }
}

export const zodBody = <TOut>(schema: ZodType<TOut>): ZodValidationPipe<TOut> =>
  new ZodValidationPipe(schema);

export const zodParam = <TOut>(schema: ZodType<TOut>): ZodValidationPipe<TOut> =>
  new ZodValidationPipe(schema);

export const zodQuery = <TOut>(schema: ZodType<TOut>): ZodValidationPipe<TOut> =>
  new ZodValidationPipe(schema);
