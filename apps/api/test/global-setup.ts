import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVER_START_TIMEOUT_MS, TEST_API_BASE, testEnv } from './support/test-env.js';

/**
 * Brings up everything the integration tests need, once for the whole run:
 * the test database, its schema, a compiled API, and the API process itself.
 *
 * The API is spawned as a child process instead of being instantiated in the test
 * process, for two reasons. It is the only way to test the real bootstrap, and it keeps
 * the test process free of the decorator/`emitDecoratorMetadata`/Prisma-client setup
 * that the compiled server already has exactly right.
 */

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let server: ChildProcess | null = null;

/**
 * Runs a Node script directly.
 *
 * `execFileSync` without a shell: `process.execPath` contains a space on Windows
 * (`C:\Program Files\nodejs\node.exe`), and handing that to a shell splits it at the
 * space and fails with "not recognized as an internal or external command".
 */
function runNode(script: string, env: NodeJS.ProcessEnv): void {
  execFileSync(process.execPath, [script], { cwd: apiRoot, env, stdio: 'inherit' });
}

/**
 * Runs a package-manager command.
 *
 * `pnpm` is a shim (`.cmd`), and Windows cannot execute one without a shell. The whole
 * command is passed as a single string so the arguments are not concatenated with
 * unescaped quoting.
 */
function runPnpm(command: string, env: NodeJS.ProcessEnv): void {
  execSync(`pnpm ${command}`, { cwd: apiRoot, env, stdio: 'inherit' });
}

async function waitForReady(env: NodeJS.ProcessEnv, healthPath: string): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  let lastError = 'no response';

  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(
        `The API exited with code ${server.exitCode} before becoming ready.\n\n${errorOutput}`,
      );
    }

    try {
      const response = await fetch(healthPath);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((done) => setTimeout(done, 250));
  }

  throw new Error(
    `The API did not become ready within ${SERVER_START_TIMEOUT_MS} ms (last: ${lastError}).\n\n${errorOutput}`,
  );
}

/** Captured output, so a failed start reports the server's own explanation. */
let errorOutput = '';

/**
 * Turns the platform's blocking switch on for the suite.
 *
 * Talks to the real owner routes instead of writing the table directly: the fixture then
 * fails the same way a broken admin session or a guarded route would, which is worth
 * knowing before 26 test files start.
 */
async function enableBlocking(token: string | undefined): Promise<void> {
  if (!token) throw new Error('ADMIN_TOKEN is missing from the test environment.');

  const signIn = await fetch(`${TEST_API_BASE}/admin/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!signIn.ok) throw new Error(`admin sign-in failed: ${signIn.status}`);

  const cookie = signIn.headers
    .getSetCookie()
    .find((value) => value.startsWith('anonlink_admin='))
    ?.split(';')[0];
  if (!cookie) throw new Error('admin sign-in did not set a cookie.');

  const updated = await fetch(`${TEST_API_BASE}/admin/platform`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ blockingEnabled: true }),
  });
  if (!updated.ok) throw new Error(`admin platform update failed: ${updated.status}`);
}

export default async function setup(): Promise<() => Promise<void>> {
  const env = testEnv();

  if (!env.DATABASE_URL.endsWith('_test') && !env.DATABASE_URL.includes('_test?')) {
    throw new Error(
      `Refusing to run tests against "${env.DATABASE_URL}": expected a *_test database.`,
    );
  }

  // 1. The database itself. Reuses the very script the app's build uses, so
  //    "database does not exist" is handled (and tested) in exactly one place.
  runNode(join('scripts', 'ensure-database.mjs'), env);

  // 2. The schema. `migrate deploy` applies the committed migrations without
  //    generating new ones or prompting — the only variant safe in automation.
  runPnpm('exec prisma migrate deploy', env);

  // 3. A build. The API relies on `emitDecoratorMetadata`, which esbuild-based runners
  //    do not emit, so the tests must run the compiled output.
  if (!existsSync(join(apiRoot, 'dist', 'main.js'))) {
    process.stdout.write('[test] dist/main.js is missing — building the API first.\n');
    runPnpm('run build', env);
  }

  // 4. The API itself.
  server = spawn(process.execPath, [join('dist', 'main.js')], {
    cwd: apiRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout?.on('data', (chunk: Buffer) => {
    errorOutput += chunk.toString();
  });
  server.stderr?.on('data', (chunk: Buffer) => {
    errorOutput += chunk.toString();
  });

  await waitForReady(env, `${TEST_API_BASE}/health/ready`);

  // 5. Blocking is a platform policy and ships **off** (D31). Most suites here are about
  //    the mechanics of blocking, not about the shipped default, so the fixture turns it
  //    on once. `platform.test.ts` exercises the default and restores this state itself.
  await enableBlocking(env.ADMIN_TOKEN);

  return async () => {
    if (!server) return;
    const child = server;
    server = null;

    // The API handles SIGTERM by marking live chats as finished and closing the
    // database pool (see `ChatService.onApplicationShutdown`), so this is a graceful
    // stop rather than a kill wherever the platform allows it.
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGTERM');

    const forced = setTimeout(() => {
      child.kill('SIGKILL');
    }, 5_000);

    await exited;
    clearTimeout(forced);
  };
}
