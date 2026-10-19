#!/usr/bin/env node
/**
 * One-command setup: `pnpm setup`.
 *
 * The project owner should be able to clone the repository, run one command, and end up
 * with a working application. This script performs every step that is mechanical and
 * safe to repeat:
 *
 *   1. check the Node.js version
 *   2. create `.env` from `.env.example` if it is missing
 *   3. install dependencies
 *   4. check that PostgreSQL answers, and explain exactly how to start it if it does not
 *   5. create the database if it does not exist
 *   6. apply migrations (never generates new ones, never prompts)
 *   7. build every package
 *
 * It is safe to run again at any time: each step detects that it has already been done.
 * It never deletes data and never touches the database schema destructively.
 *
 * Usage:
 *   pnpm setup
 *   node scripts/setup.mjs --no-build      # skip the final build (CI, quick DB fix)
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import process from 'node:process';

import {
  ENV_EXAMPLE_PATH,
  ENV_PATH,
  REPO_ROOT,
  compareVersions,
  loadEnvironment,
  maskDatabaseUrl,
  parseDatabaseUrl,
  parseMinimumVersion,
  readJson,
} from './lib/env.mjs';

const skipBuild = process.argv.includes('--no-build');

let step = 0;
function heading(title) {
  step += 1;
  console.log(`\n[${step}] ${title}`);
  console.log('-'.repeat(Math.max(title.length + 6, 20)));
}

function fail(message, hint) {
  console.error(`\nОШИБКА: ${message}`);
  if (hint) console.error(hint);
  console.error('\nПолная диагностика: pnpm diagnose');
  process.exit(1);
}

/**
 * Runs a command and stops the setup if it fails.
 *
 * `pnpm` is a `.cmd` shim on Windows, so it has to go through a shell; `shell: true`
 * plus `stdio: 'inherit'` also means the owner sees the real output of every tool
 * instead of a summary that hides the interesting part.
 */
function run(command, args, options = {}) {
  const printable = [command, ...args].join(' ');
  process.stdout.write(`\n> ${printable}\n`);

  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: true,
    ...options,
  });

  if (result.status !== 0) {
    fail(`команда завершилась с ошибкой (код ${result.status ?? 'неизвестен'}): ${printable}`);
  }
}

// ---------------------------------------------------------------------------

console.log('AnonLink — настройка проекта');
console.log(`Папка проекта: ${REPO_ROOT}`);

// --- 1. Node -----------------------------------------------------------------
heading('Проверка Node.js');

const pkg = readJson('package.json');
const minimum = parseMinimumVersion(pkg.engines?.node);
const nodeVersion = process.versions.node;

if (minimum) {
  const required = `${minimum.major}.${minimum.minor}.${minimum.patch}`;
  if (compareVersions(nodeVersion, required) < 0) {
    fail(
      `нужен Node.js ${pkg.engines.node}, установлен ${nodeVersion}`,
      [
        'Установите Node.js LTS: https://nodejs.org/',
        'После установки закройте и заново откройте PowerShell, затем повторите: pnpm setup',
      ].join('\n'),
    );
  }
}
console.log(`Node.js ${nodeVersion} — подходит.`);

// --- 2. .env -----------------------------------------------------------------
heading('Настройки (.env)');

if (!existsSync(ENV_PATH)) {
  if (!existsSync(ENV_EXAMPLE_PATH)) {
    fail('нет ни .env, ни .env.example — восстановите файлы из репозитория');
  }

  copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
  console.log(`Создан файл .env по образцу .env.example.`);

  const created = loadEnvironment();
  const parsed = parseDatabaseUrl(process.env.DATABASE_URL);
  if (parsed.ok) {
    console.log(`База данных: ${maskDatabaseUrl(process.env.DATABASE_URL)}`);
    console.log(
      'Если логин или пароль отличаются от стандартных, откройте .env в блокноте и исправьте DATABASE_URL.',
    );
  }
  void created;
} else {
  console.log('Файл .env уже есть — оставляю без изменений.');
  loadEnvironment();
}

const parsedUrl = parseDatabaseUrl(process.env.DATABASE_URL);
if (!parsedUrl.ok) {
  fail(
    `в .env неверный DATABASE_URL (${parsedUrl.reason})`,
    'Откройте .env и исправьте строку DATABASE_URL.',
  );
}
console.log(`База данных: ${maskDatabaseUrl(process.env.DATABASE_URL)}`);

// --- 3. Dependencies ---------------------------------------------------------
heading('Установка зависимостей');

if (existsSync(`${REPO_ROOT}/node_modules`)) {
  console.log('Уже установлены — проверю, что версии совпадают с pnpm-lock.yaml.');
}
run('pnpm', ['install']);

// --- 4. Database reachable ---------------------------------------------------
heading('Проверка PostgreSQL');

const { Client } = await import('pg');

const client = new Client({
  host: parsedUrl.host,
  port: parsedUrl.port,
  user: parsedUrl.user,
  password: parsedUrl.password,
  database: parsedUrl.database,
  connectionTimeoutMillis: 5000,
  ...(parsedUrl.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
});

try {
  await client.connect();
  console.log(`PostgreSQL отвечает, база "${parsedUrl.database}" доступна.`);
} catch (error) {
  await client.end().catch(() => {});

  if (error?.code === 'ECONNREFUSED') {
    fail(
      `PostgreSQL не отвечает на ${parsedUrl.host}:${parsedUrl.port}`,
      [
        'Запустите службу PostgreSQL в PowerShell с правами администратора:',
        '',
        '    Start-Service postgresql-x64-18',
        '    Get-Service postgresql-x64-18',
        '',
        'Затем повторите: pnpm setup',
      ].join('\n'),
    );
  }

  if (error?.code === '3D000') {
    // Not a failure: the next step creates it.
    console.log(`Базы "${parsedUrl.database}" пока нет — она будет создана на следующем шаге.`);
  } else if (error?.code === '28P01' || error?.code === '28000') {
    fail(
      'PostgreSQL отклонил логин или пароль из DATABASE_URL',
      [
        'Либо исправьте логин и пароль в .env, либо создайте роль и базу заново',
        '(одна команда, от имени суперпользователя postgres):',
        '',
        "    $env:PGPASSWORD='<пароль postgres>'",
        '    & "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe" -U postgres -h localhost -d postgres `',
        '        -v ON_ERROR_STOP=1 -f infrastructure/postgres/init.sql',
      ].join('\n'),
    );
  } else {
    fail(
      `не удалось подключиться к PostgreSQL: ${error?.code ?? ''} ${error?.message ?? ''}`.trim(),
      'Проверьте параметры в .env — подробный отчёт даст команда: pnpm diagnose',
    );
  }
} finally {
  await client.end().catch(() => {});
}

// --- 5. Database exists ------------------------------------------------------
heading('Создание базы данных (если её ещё нет)');
run('node', ['apps/api/scripts/ensure-database.mjs']);

// --- 6. Migrations -----------------------------------------------------------
heading('Применение миграций');
// `migrate deploy` only applies the committed migrations: it never invents a new one,
// never prompts, and is the only variant that is safe to run unattended.
run('pnpm', ['--filter', '@anonlink/api', 'exec', 'prisma', 'migrate', 'deploy']);

// --- 7. Build ----------------------------------------------------------------
if (skipBuild) {
  heading('Сборка пропущена (--no-build)');
} else {
  heading('Сборка проекта');
  run('pnpm', ['build']);
}

// ---------------------------------------------------------------------------

console.log('\nГотово. Проект настроен.\n');
console.log('  Запустить приложение:  pnpm dev');
console.log('  Открыть в браузере:    http://localhost:3000');
console.log('  Остановить:            Ctrl+C в том же окне');
console.log('\n  Если что-то не работает:  pnpm diagnose\n');
