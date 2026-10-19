/**
 * Stops the servers started by `global-setup.ts`.
 *
 * The PIDs travel through a file rather than module state because Playwright does not
 * guarantee that setup and teardown share a process. The file also makes an interrupted
 * run recoverable: the next setup reads it and stops whatever is still alive.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';

import { E2E_PATHS } from './env';
import { killTree } from './support/processes';

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(E2E_PATHS.serversFile)) return;

  const { api, web } = JSON.parse(readFileSync(E2E_PATHS.serversFile, 'utf8')) as {
    api?: number;
    web?: number;
  };

  // Web first: it is the process a human might be watching in a browser window.
  for (const [name, pid] of [
    ['web', web],
    ['api', api],
  ] as const) {
    if (typeof pid === 'number') {
      killTree(pid);
      console.log(`[e2e] stopped ${name} (pid ${pid})`);
    }
  }

  rmSync(E2E_PATHS.serversFile, { force: true });
}
