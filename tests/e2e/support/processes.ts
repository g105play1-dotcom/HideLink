/**
 * Process and network helpers for the global setup / teardown.
 *
 * Kept separate from `env.ts` so the environment description stays declarative and this
 * file holds every place that actually touches the machine.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Runs a command to completion and fails loudly if it does not succeed.
 *
 * `stdio: 'inherit'` is intentional: when a build breaks, the real compiler output is
 * what the developer needs to see, not a one-line summary of it.
 */
export function run(command: string, args: string[], options: RunOptions): void {
  const printable = [command, ...args].join(' ');
  console.log(`[e2e] $ ${printable}`);

  // `pnpm` is a `.cmd` shim on Windows and can only be resolved by a shell. The command
  // is joined into one string in that case, which is also what avoids Node's
  // "args with shell" deprecation warning. Nothing here comes from user input.
  const needsShell = command === 'pnpm';

  const result = spawnSync(needsShell ? printable : command, needsShell ? [] : args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
    shell: needsShell,
    timeout: options.timeoutMs ?? 300_000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[e2e] command failed (exit ${result.status ?? 'unknown'}): ${printable}`);
  }
}

/** Starts a long-lived process, appending its output to `logFile`. */
export function startProcess(
  name: string,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; logFile: string },
): { name: string; pid: number } {
  const descriptor = openSync(options.logFile, 'a');

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', descriptor, descriptor],
  });

  // The child holds its own duplicate of the descriptor; keeping ours open would leak
  // a handle in the Playwright process for the whole run.
  closeSync(descriptor);

  if (child.pid === undefined) throw new Error(`[e2e] ${name} could not be started`);

  child.once('exit', (code, signal) => {
    console.log(`[e2e] ${name} exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
  });

  console.log(`[e2e] ${name} started (pid ${child.pid})`);
  return { name, pid: child.pid };
}

/** Kills a process and everything it spawned. */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    // `taskkill /T` is the only reliable way to reach a grandchild on Windows; the
    // Unix process-group equivalent does not exist there.
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone: nothing to do.
  }
}

/** Whether nothing is listening on `port` of the loopback interface. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 1_500 });

    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(true));
  });
}

/** Polls `url` until it answers 2xx, or fails with the tail of the server's log. */
export async function waitForHttp(
  url: string,
  options: { timeoutMs: number; label: string; logFile?: string },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError = 'no attempt was made';

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }

    await delay(250);
  }

  const tail = options.logFile ? readTail(options.logFile, 40) : '';
  throw new Error(
    `[e2e] ${options.label} did not become ready within ${options.timeoutMs} ms (${lastError})` +
      (tail ? `\n--- ${options.label} log ---\n${tail}` : ''),
  );
}

/** The last `lines` lines of a log file, for failure messages. */
export function readTail(path: string, lines: number): string {
  try {
    return readFileSync(path, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}
