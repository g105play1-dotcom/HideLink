import { Global, Module } from '@nestjs/common';

import { PlatformService } from './platform.service.js';

/**
 * Installation-wide platform policy.
 *
 * Global because three unrelated places need the same answer and none of them owns it:
 * the identity surface (to report it to the browser), the chat domain (to refuse a block)
 * and the owner's admin controller (to change it). Importing this module three times
 * would still produce one instance — Nest modules are singletons — but the global
 * registration says plainly that this is shared infrastructure, like the config.
 */
@Global()
@Module({
  providers: [PlatformService],
  exports: [PlatformService],
})
export class PlatformModule {}
