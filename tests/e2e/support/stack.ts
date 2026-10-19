/**
 * Control over the servers `global-setup.ts` started.
 *
 * Only the API is ever restarted: the point is to prove that the client survives the
 * loss of the *stateful* half of the stack. The in-memory chats die with that process,
 * which is exactly the situation the client has to reconcile itself with.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { E2E_API_BASE, E2E_API_PORT, E2E_PATHS, serverEnv } from '../env';
import { isPortFree, killTree, startProcess, waitForHttp } from './processes';

interface Servers {
  api?: number;
  web?: number;
}

function readServers(): Servers {
  if (!existsSync(E2E_PATHS.serversFile)) return {};
  return JSON.parse(readFileSync(E2E_PATHS.serversFile, 'utf8')) as Servers;
}

function writeServers(servers: Servers): void {
  // The file is rewritten so that global teardown (and the next run's stale-process
  // check) sees the *current* API pid, not the one that was killed mid-test.
  writeFileSync(E2E_PATHS.serversFile, JSON.stringify(servers, null, 2));
}

/** Stops the API. Every in-memory chat and queue entry is lost with it. */
export function stopApi(): void {
  const servers = readServers();
  if (typeof servers.api !== 'number') throw new Error('[e2e] no API pid to stop');

  killTree(servers.api);
  writeServers({ ...servers, api: undefined });
}

/** Starts a fresh API process and waits until it answers readiness checks. */
export async function startApi(): Promise<void> {
  // Windows releases a killed process's listening socket asynchronously, so binding a
  // new one on the same port can fail if we are a fraction of a second too early.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await isPortFree(E2E_API_PORT)) break;
    await delay(250);
  }

  const servers = readServers();

  const api = startProcess('api (restarted)', process.execPath, [E2E_PATHS.apiEntry], {
    cwd: E2E_PATHS.apiRoot,
    env: serverEnv(),
    logFile: E2E_PATHS.apiLog,
  });

  writeServers({ ...servers, api: api.pid });

  await waitForHttp(`${E2E_API_BASE}/health/ready`, {
    timeoutMs: 60_000,
    label: 'api',
    logFile: E2E_PATHS.apiLog,
  });
}
