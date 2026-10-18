// Prisma CLI configuration (Prisma ORM 7).
//
// Prisma 7 does not load `.env` automatically, and the datasource URL moved out of
// `schema.prisma` into this file. AnonLink keeps a single `.env` at the repository
// root, so it is located by walking up from the working directory — the same
// strategy the API uses at runtime, which keeps `pnpm db:migrate` working no matter
// where it is invoked from.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

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

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
