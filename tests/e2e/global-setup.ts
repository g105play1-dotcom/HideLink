/**
 * Brings up the entire stack for the end-to-end suite.
 *
 * Order matters and is not negotiable:
 *   1. a stale stack from an interrupted run is stopped first, so ports are free;
 *   2. the test database exists and carries the committed migrations;
 *   3. the API is rebuilt from the working tree — the suite must test *this* code;
 *   4. the web bundle is built only when it is stale, because a Next build costs far
 *      more than everything else here put together;
 *   5. both servers are started and polled until they answer.
 *
 * Playwright's own `webServer` option is deliberately not used: it starts servers before
 * `globalSetup`, which would let the API boot against a database that has not been
 * migrated yet.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  E2E_API_BASE,
  E2E_API_PORT,
  E2E_PATHS,
  E2E_WEB_ORIGIN,
  E2E_WEB_PORT,
  REPO_ROOT,
  SERVER_START_TIMEOUT_MS,
  serverEnv,
} from './env';
import { isPortFree, killTree, run, startProcess, waitForHttp } from './support/processes';

export default async function globalSetup(): Promise<void> {
  console.log('[e2e] preparing the stack (web 3200, api 3201)');

  stopStaleStack();

  rmSync(E2E_PATHS.run, { recursive: true, force: true });
  mkdirSync(E2E_PATHS.run, { recursive: true });

  await ensurePortsAreFree();
  prepareDatabase();
  buildApi();
  buildWebIfStale();

  const api = startProcess('api', process.execPath, [E2E_PATHS.apiEntry], {
    cwd: E2E_PATHS.apiRoot,
    env: serverEnv(),
    logFile: E2E_PATHS.apiLog,
  });

  try {
    await waitForHttp(`${E2E_API_BASE}/health/ready`, {
      timeoutMs: SERVER_START_TIMEOUT_MS,
      label: 'api',
      logFile: E2E_PATHS.apiLog,
    });
  } catch (error) {
    killTree(api.pid);
    throw error;
  }

  // `next start` reads `next.config.ts`, so it needs the same flag that produced the
  // `.next-e2e` build — otherwise it would serve the development bundle.
  const web = startProcess(
    'web',
    process.execPath,
    [E2E_PATHS.nextCli, 'start', '--port', String(E2E_WEB_PORT)],
    {
      cwd: E2E_PATHS.webRoot,
      env: serverEnv({ ANONLINK_E2E: '1' }),
      logFile: E2E_PATHS.webLog,
    },
  );

  try {
    await waitForHttp(E2E_WEB_ORIGIN, {
      timeoutMs: SERVER_START_TIMEOUT_MS,
      label: 'web',
      logFile: E2E_PATHS.webLog,
    });
  } catch (error) {
    killTree(web.pid);
    killTree(api.pid);
    throw error;
  }

  writeFileSync(E2E_PATHS.serversFile, JSON.stringify({ api: api.pid, web: web.pid }, null, 2));
  console.log('[e2e] stack is ready');
}

/**
 * Stops servers left behind by a previous run that was interrupted (Ctrl+C, a crash).
 *
 * Without this the next run would fail with "port already in use" and the developer
 * would have to hunt for processes by hand.
 */
function stopStaleStack(): void {
  if (!existsSync(E2E_PATHS.serversFile)) return;

  try {
    const stale = JSON.parse(readFileSync(E2E_PATHS.serversFile, 'utf8')) as {
      api?: number;
      web?: number;
    };

    for (const pid of [stale.web, stale.api]) {
      if (typeof pid === 'number') {
        killTree(pid);
        console.log(`[e2e] stopped a server left over from a previous run (pid ${pid})`);
      }
    }
  } catch {
    // A corrupt file is not worth failing over: the port check below is the real guard.
  }
}

async function ensurePortsAreFree(): Promise<void> {
  const ports = [
    { name: 'api', port: E2E_API_PORT },
    { name: 'web', port: E2E_WEB_PORT },
  ];

  for (const { name, port } of ports) {
    if (await isPortFree(port)) continue;

    throw new Error(
      `[e2e] port ${port} (${name}) is already in use.\n` +
        'Another end-to-end run may still be shutting down — wait a few seconds and retry.\n' +
        `If not, find the process: Get-NetTCPConnection -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess`,
    );
  }
}

function prepareDatabase(): void {
  run(process.execPath, [join(E2E_PATHS.apiRoot, 'scripts', 'ensure-database.mjs')], {
    cwd: E2E_PATHS.apiRoot,
    env: serverEnv(),
  });

  // `migrate deploy` only applies committed migrations: it never creates a new one and
  // never prompts, which is the one variant that is safe to run unattended.
  run('pnpm', ['--filter', '@anonlink/api', 'exec', 'prisma', 'migrate', 'deploy'], {
    cwd: REPO_ROOT,
    env: serverEnv(),
  });
}

function buildApi(): void {
  // Always rebuilt. A suite that exercises yesterday's `dist` is worse than a slow one,
  // and the trailing `...` makes pnpm build the workspace dependencies (shared,
  // protocol) first, in dependency order.
  run('pnpm', ['--filter', '@anonlink/api...', 'build'], {
    cwd: REPO_ROOT,
    env: serverEnv(),
    timeoutMs: 300_000,
  });
}

function buildWebIfStale(): void {
  if (!webBuildIsStale()) {
    console.log('[e2e] web build is up to date');
    return;
  }

  run(process.execPath, [E2E_PATHS.nextCli, 'build'], {
    cwd: E2E_PATHS.webRoot,
    env: serverEnv({ ANONLINK_E2E: '1' }),
    timeoutMs: 600_000,
  });
}

/** Whether the `.next-e2e` bundle predates the web sources it was built from. */
function webBuildIsStale(): boolean {
  if (!existsSync(E2E_PATHS.webBuildId)) return true;

  const builtAt = statSync(E2E_PATHS.webBuildId).mtimeMs;
  return newestSourceMtime(E2E_PATHS.webRoot, 0) > builtAt;
}

function newestSourceMtime(directory: string, depth: number): number {
  if (depth > 8) return 0;

  let newest = 0;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Build output and dependencies never make a build stale; only sources do.
    if (entry.name === 'node_modules' || entry.name.startsWith('.next')) continue;

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(path, depth + 1));
      continue;
    }

    newest = Math.max(newest, statSync(path).mtimeMs);
  }

  return newest;
}
