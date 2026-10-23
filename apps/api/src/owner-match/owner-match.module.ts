import { Module } from '@nestjs/common';

import { OwnerMatchService } from './owner-match.service.js';

/**
 * The data the owner's hidden join needs, imported by the chat domain.
 *
 * This module deliberately has no controller and no dependency on the admin surface:
 * `ChatService` consumes reservations and creates personas, while `OwnerAdminModule`
 * reads and writes the same rows over REST. Keeping the small shared piece below both
 * makes that a one-way dependency instead of a cycle.
 */
@Module({
  providers: [OwnerMatchService],
  exports: [OwnerMatchService],
})
export class OwnerMatchModule {}
