import { Global, Module } from '@nestjs/common';

import { RateLimitService } from './rate-limit.service.js';

/**
 * Cross-cutting services used by both transports.
 *
 * Global because rate limiting is applied by the HTTP guard *and* by the socket
 * gateway; a single shared instance is what makes the two budgets commensurate.
 */
@Global()
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class CommonModule {}
