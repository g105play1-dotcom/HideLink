import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import type { NextConfig } from 'next';

/**
 * Locates the single repository-root `.env`.
 *
 * The web app reads the *same* file as the API and Prisma, so there is exactly one
 * place to configure the stack. Next.js only auto-loads `.env` from its own project
 * directory (`apps/web`), so the shared file is loaded here, before `next build`
 * inlines any `NEXT_PUBLIC_*` value.
 */
function findEnvFile(): string | null {
  let directory = resolve(process.cwd());

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, '.env');
    if (existsSync(candidate)) return candidate;

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return null;
}

const envFile = findEnvFile();
if (envFile) loadDotenv({ path: envFile, quiet: true });

/**
 * The API origin the browser talks to directly.
 *
 * There is deliberately no Next.js rewrite/proxy in front of the API: rewrites
 * cannot proxy WebSocket upgrades, and proxying REST while connecting the socket
 * elsewhere would make the session cookie's origin ambiguous. Pointing the browser
 * at the API origin keeps `HttpOnly` cookies, CORS and Socket.IO all behaving
 * exactly as they do in production (see docs/DECISIONS.md).
 */
/**
 * End-to-end test mode (`ANONLINK_E2E=1`).
 *
 * The Playwright suite runs the whole stack itself, on ports 3200/3201, so a test run
 * can never interfere with servers the owner has open on 3000/3001.
 *
 * `NEXT_PUBLIC_*` values are inlined into the bundle at build time, so "point this build
 * at another API" means "make another build" — and that second build must not overwrite
 * the `.next` directory that `pnpm dev` and `pnpm start` use. Hence the separate output
 * directory, which is also why the mode is an explicit environment variable rather than a
 * clever default.
 */
const e2e = process.env['ANONLINK_E2E'] === '1';

const apiUrl = e2e
  ? (process.env['ANONLINK_E2E_API_URL'] ?? 'http://localhost:3201')
  : (process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001');

const nextConfig: NextConfig = {
  reactStrictMode: true,

  distDir: e2e ? '.next-e2e' : '.next',

  // Exposed to the browser by design: it is a public URL, not a secret.
  env: {
    NEXT_PUBLIC_API_URL: apiUrl,
  },

  poweredByHeader: false,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
