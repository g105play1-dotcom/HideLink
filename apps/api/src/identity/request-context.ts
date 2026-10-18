import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { ErrorCode } from '@anonlink/shared';
import type { Request } from 'express';

import { AppError } from '../common/app-error.js';
import type { AuthenticatedIdentity } from './identity.service.js';

/** Route metadata marking an endpoint that may be called without an identity. */
export const ANONYMOUS_ROUTE = 'anonlink:anonymous';

/**
 * Marks an endpoint as reachable without an anonymous identity.
 *
 * The default is the opposite (authentication required) so that forgetting a
 * decorator fails closed: the endpoint becomes unreachable instead of unprotected.
 */
export const Anonymous = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ANONYMOUS_ROUTE, true) as MethodDecorator & ClassDecorator;

/** Express request augmented with the resolved identity. */
export interface RequestWithIdentity extends Request {
  identity?: AuthenticatedIdentity;
}

/**
 * Injects the authenticated identity into a handler parameter.
 *
 * Throws if the route somehow reached the handler without one, which can only
 * happen if the route was marked `@Anonymous()` — a programming error, not a
 * user error.
 */
export const CurrentIdentity = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedIdentity => {
    const request = context.switchToHttp().getRequest<RequestWithIdentity>();
    if (!request.identity) throw new AppError(ErrorCode.IDENTITY_REQUIRED);
    return request.identity;
  },
);
