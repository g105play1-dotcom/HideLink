import { Global, Module } from '@nestjs/common';

import { AppEventBus } from './app-events.js';

/**
 * Global because the bus is a shared channel between exactly one producer set
 * (chat, identity) and one consumer set (the socket gateway). Two instances would
 * silently stop delivering events.
 */
@Global()
@Module({
  providers: [AppEventBus],
  exports: [AppEventBus],
})
export class EventsModule {}
