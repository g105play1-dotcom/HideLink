import { Module } from '@nestjs/common';

import { ChatModule } from '../chat/chat.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ChatGateway } from './chat.gateway.js';

/**
 * The Socket.IO surface.
 *
 * Imports the two modules whose services the gateway drives: chat (the rules) and
 * identity (turning the handshake cookie into an identity). Presence, rate limiting,
 * the event bus and configuration are global.
 */
@Module({
  imports: [ChatModule, IdentityModule],
  providers: [ChatGateway],
  exports: [ChatGateway],
})
export class RealtimeModule {}
