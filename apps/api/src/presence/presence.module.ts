import { Global, Module } from '@nestjs/common';

import { PresenceService } from './presence.service.js';

/**
 * Global so that both the realtime gateway and the chat service can depend on
 * presence without depending on each other.
 */
@Global()
@Module({
  providers: [PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
