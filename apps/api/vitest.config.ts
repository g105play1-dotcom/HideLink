import { defineConfig } from 'vitest/config';

import { TEST_ENV, resolveTestDatabaseUrl } from './test/support/test-env.js';

/**
 * The API test suite.
 *
 * Integration tests run against a *real* spawned server (see `test/global-setup.ts`)
 * rather than an in-process Nest instance. That is a deliberate trade:
 *
 *  - It exercises the actual bootstrap. The missing `@WebSocketGateway()` decorator —
 *    which made every WebSocket handshake 404 — was invisible to the type checker and
 *    would have been invisible to an in-process test that built the gateway by hand.
 *  - It avoids re-implementing the module graph in the test.
 *
 * A single fork runs the files sequentially. The server holds every chat and the match
 * queue in memory, and one PostgreSQL database backs them all, so parallel files would
 * interfere with each other's queue state rather than run faster.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    environment: 'node',
    pool: 'forks',
    // One worker, one file at a time. The spawned API holds every chat and the match
    // queue in memory, so parallel files would interfere with each other's queue state
    // rather than run faster.
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 90_000,
    // Surfaced to the test files. `DATABASE_URL` also lets a test use Prisma directly
    // when it needs to assert what was actually persisted.
    env: { ...TEST_ENV, DATABASE_URL: resolveTestDatabaseUrl() },
  },
});
