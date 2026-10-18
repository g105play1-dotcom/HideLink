import { Global, Module } from '@nestjs/common';

import { DirectoryService } from './directory.service.js';

/**
 * Global because the cached identity facts are consulted by identity, chat and
 * moderation code alike, and because there must be exactly one cache: two copies
 * could disagree about a block, which would be a correctness bug, not an
 * optimisation issue.
 */
@Global()
@Module({
  providers: [DirectoryService],
  exports: [DirectoryService],
})
export class DirectoryModule {}
