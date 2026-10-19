import { Body, Controller, Post } from '@nestjs/common';
import {
  ownerMessageSchema,
  type OwnerMessageCreatedResponse,
  type OwnerMessageInput,
} from '@anonlink/shared';

import { RateLimitService } from '../common/rate-limit.service.js';
import { zodBody } from '../common/zod-validation.pipe.js';
import { CurrentIdentity } from '../identity/request-context.js';
import type { AuthenticatedIdentity } from '../identity/identity.service.js';
import { OwnerMessageService } from './owner.service.js';

/**
 * "Contact the owner" over REST.
 *
 * This is the *only* place the API accepts free text that is not a chat message, so it is
 * treated accordingly:
 *  - the body is validated against the shared schema (topic from a fixed vocabulary, text
 *    bounded), and `.strict()` means an unknown field is a rejection rather than a silent
 *    drop;
 *  - the sender's User ID comes from the session, never from the body, so nobody can file
 *    a message as somebody else;
 *  - the budget is per identity and small (`RATE_LIMIT_OWNER_MESSAGE_PER_DAY`), because an
 *    unlimited operator inbox is a spam target.
 */
@Controller('owner')
export class OwnerController {
  constructor(
    private readonly messages: OwnerMessageService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Files one message for the owner. Answers with its id and expiry. */
  @Post('messages')
  async create(
    @CurrentIdentity() identity: AuthenticatedIdentity,
    @Body(zodBody(ownerMessageSchema)) body: OwnerMessageInput,
  ): Promise<OwnerMessageCreatedResponse> {
    this.rateLimit.enforce('ownerMessage', identity.userId);

    return this.messages.create({
      identityId: identity.userId,
      topic: body.topic,
      text: body.text,
      contact: body.contact,
    });
  }
}
