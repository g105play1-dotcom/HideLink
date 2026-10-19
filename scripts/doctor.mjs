#!/usr/bin/env node
/**
 * Environment diagnostics: `pnpm diagnose`.
 *
 * Written for the project owner, who is not expected to read code to find out what is
 * wrong. Every check answers three questions in order: what was looked at, whether it is
 * fine, and — when it is not — the exact command that fixes it.
 *
 * The output is deliberately in Russian, like the application itself, while the
 * technical details (versions, paths, error codes) stay as they are, so a log can be
 * pasted into a bug report without translation.
 *
 * Nothing here changes the system: it only reads. The one exception is creating a
 * throwaway TCP connection to see whether a port is busy.
 *
 * Usage:
 *   pnpm diagnose
 *   node scripts/doctor.mjs --verbose     # include every detail, even for passing checks
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import process from 'node:process';

import pg from 'pg';

import {
  ENV_PATH,
  REPO_ROOT,
  compareVersions,
  envKeys,
  exists,
  loadEnvironment,
  maskDatabaseUrl,
  parseDatabaseUrl,
  parseMinimumVersion,
  readJson,
} from './lib/env.mjs';

const { Client } = pg;

const verbose = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const ICONS = { ok: 'OK  ', warn: 'ВНИМАНИЕ', fail: 'ОШИБКА' };

const results = [];

/** Records and prints one check. `hint` is printed only when the status is not `ok`. */
function check(status, title, detail, hint) {
  results.push({ status, title });

  const icon = ICONS[status];
  console.log(`  [${icon}] ${title}`);
  if (detail && (verbose || status !== 'ok')) console.log(`           ${detail}`);
  if (hint && status !== 'ok') {
    for (const line of hint.split('\n')) console.log(`           ${line}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkToolchain() {
  section('1/5  Система');

  const pkg = readJson('package.json');
  const minimum = parseMinimumVersion(pkg.engines?.node);
  const nodeVersion = process.versions.node;

  if (
    minimum &&
    compareVersions(nodeVersion, `${minimum.major}.${minimum.minor}.${minimum.patch}`) < 0
  ) {
    check(
      'fail',
      `Node.js ${nodeVersion} — слишком старый`,
      `Проект требует Node.js ${pkg.engines.node}`,
      [
        'Обновите Node.js LTS: https://nodejs.org/  (или: winget install OpenJS.NodeJS.LTS)',
        'После установки закройте и заново откройте PowerShell, затем повторите: pnpm diagnose',
      ].join('\n'),
    );
  } else {
    check('ok', `Node.js ${nodeVersion}`, `требуется ${pkg.engines?.node ?? '(не задано)'}`);
  }

  // When the script is started through pnpm, the user agent tells us the version
  // without spawning a process. Started directly with `node`, we ask pnpm itself.
  const fromAgent = /pnpm\/(\d+\.\d+\.\d+)/.exec(process.env.npm_config_user_agent ?? '')?.[1];
  const pnpmVersion = fromAgent ?? runVersion('pnpm --version');

  if (!pnpmVersion) {
    check(
      'fail',
      'pnpm не найден',
      null,
      [
        'Включите pnpm (входит в Node.js, ничего скачивать не нужно):',
        '    corepack enable',
        '    corepack prepare pnpm@latest --activate',
      ].join('\n'),
    );
  } else {
    const declared = String(readJson('package.json').packageManager ?? '').replace('pnpm@', '');
    check('ok', `pnpm ${pnpmVersion}`, declared ? `в проекте заявлен pnpm ${declared}` : undefined);
  }

  const gitVersion = runVersion('git --version');
  check(
    gitVersion ? 'ok' : 'warn',
    gitVersion ?? 'Git не найден',
    gitVersion ? null : 'без Git история изменений проекта не сохраняется',
    gitVersion ? undefined : 'Установите Git: winget install Git.Git',
  );

  check(
    'ok',
    `${process.platform} ${process.arch}`,
    `версия системы ${process.getSystemVersion?.() ?? ''}`.trim(),
  );
}

function runVersion(commandWithArgs) {
  const result = spawnSync(commandWithArgs, { shell: true, encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) return null;
  return (
    String(result.stdout ?? '')
      .trim()
      .split(/\r?\n/)[0] || null
  );
}

function checkFiles() {
  section('2/5  Файлы проекта');

  const env = loadEnvironment();

  if (!env.found) {
    check(
      'fail',
      'Файл .env не найден',
      ENV_PATH,
      [
        'Создайте его из образца и запустите настройку:',
        '    Copy-Item .env.example .env',
        '    pnpm setup',
      ].join('\n'),
    );
  } else {
    const keys = envKeys();
    check('ok', `Файл .env найден (${keys.length} настроек)`, ENV_PATH);

    const parsed = parseDatabaseUrl(process.env.DATABASE_URL);
    if (!parsed.ok) {
      check(
        'fail',
        'В .env неверный DATABASE_URL',
        parsed.reason,
        [
          'Нужна строка вида:',
          '    DATABASE_URL="postgresql://anonlink:anonlink@localhost:5432/anonlink?schema=public"',
        ].join('\n'),
      );
    } else {
      check(
        'ok',
        `DATABASE_URL указывает на базу "${parsed.database}"`,
        maskDatabaseUrl(process.env.DATABASE_URL),
      );
    }
  }

  if (
    exists('node_modules') &&
    exists('apps/api/node_modules') &&
    exists('apps/web/node_modules')
  ) {
    check('ok', 'Зависимости установлены', 'node_modules на месте');
  } else {
    check('fail', 'Зависимости не установлены', null, 'Выполните: pnpm install');
  }

  const artifacts = [
    ['packages/shared/dist/index.js', 'библиотека общих правил (@anonlink/shared)'],
    ['packages/protocol/dist/index.js', 'описание протокола (@anonlink/protocol)'],
    ['apps/api/dist/main.js', 'серверная часть (API)'],
    ['apps/api/src/generated/prisma', 'клиент базы данных (Prisma)'],
    ['apps/web/.next/BUILD_ID', 'веб-приложение'],
  ];

  const missing = artifacts.filter(([path]) => !exists(path)).map(([, label]) => label);

  if (missing.length === 0) {
    check('ok', 'Проект собран', 'все артефакты на месте');
  } else {
    check('warn', `Не собраны компоненты: ${missing.join(', ')}`, null, 'Выполните: pnpm build');
  }

  const dirty = spawnSync('git status --porcelain', { shell: true, encoding: 'utf8' });
  if (dirty.status === 0) {
    const lines = String(dirty.stdout ?? '')
      .split(/\r?\n/)
      .filter(Boolean);
    check(
      'ok',
      lines.length === 0
        ? 'Незакоммиченных изменений нет'
        : `Незакоммиченных изменений: ${lines.length}`,
      lines.length === 0
        ? undefined
        : 'это нормально во время работы; сохранить их: git add -A; git commit -m "..."',
    );
  }
}

async function checkDatabase() {
  section('3/5  База данных');

  const parsed = parseDatabaseUrl(process.env.DATABASE_URL);
  if (!parsed.ok) {
    check(
      'fail',
      'Проверка базы пропущена',
      parsed.reason,
      'Исправьте DATABASE_URL в .env и повторите.',
    );
    return;
  }

  const client = new Client({
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
    connectionTimeoutMillis: 5000,
    ...(parsed.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});

    if (error?.code === 'ECONNREFUSED') {
      check(
        'fail',
        `PostgreSQL не отвечает на ${parsed.host}:${parsed.port}`,
        error.message,
        [
          'Запустите службу PostgreSQL (нужны права администратора):',
          '    Start-Service postgresql-x64-18',
          '    Get-Service postgresql-x64-18     # состояние должно быть Running',
        ].join('\n'),
      );
    } else if (error?.code === '3D000') {
      check(
        'fail',
        `Базы данных "${parsed.database}" не существует`,
        error.message,
        'Создать её: pnpm setup',
      );
    } else if (error?.code === '28P01' || error?.code === '28000') {
      check(
        'fail',
        'PostgreSQL отклонил логин или пароль',
        error.message,
        [
          'Проверьте логин и пароль в DATABASE_URL (.env).',
          'Если роль ещё не создана, выполните один раз от имени суперпользователя:',
          "    $env:PGPASSWORD='<пароль postgres>'",
          '    & "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe" -U postgres -h localhost `',
          '        -d postgres -v ON_ERROR_STOP=1 -f infrastructure/postgres/init.sql',
        ].join('\n'),
      );
    } else {
      check(
        'fail',
        `Не удалось подключиться к PostgreSQL`,
        `${error?.code ?? ''} ${error?.message ?? ''}`.trim(),
        'pnpm setup',
      );
    }
    return;
  }

  check(
    'ok',
    `PostgreSQL отвечает (${parsed.host}:${parsed.port})`,
    `база "${parsed.database}", пользователь "${parsed.user}"`,
  );

  try {
    const { rows } = await client.query(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name',
    );
    const applied = rows.map((row) => row.migration_name);

    const directory = join(REPO_ROOT, 'apps', 'api', 'prisma', 'migrations');
    const onDisk = existsSync(directory)
      ? readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      : [];

    const pending = onDisk.filter((name) => !applied.includes(name));
    const unknown = applied.filter((name) => !onDisk.includes(name));

    if (pending.length === 0) {
      check(
        'ok',
        `Схема базы данных актуальна (миграций: ${applied.length})`,
        applied.join(', ') || undefined,
      );
    } else {
      check(
        'fail',
        `Не применены миграции: ${pending.join(', ')}`,
        null,
        'Применить их: pnpm db:deploy',
      );
    }

    if (unknown.length > 0) {
      check(
        'warn',
        `В базе есть миграции, которых нет в проекте: ${unknown.join(', ')}`,
        null,
        'Обычно это означает, что база создана другой версией проекта. Данные при этом не теряются.',
      );
    }

    const { rows: sizes } = await client.query(
      `SELECT relname AS table_name, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 5`,
    );
    if (sizes.length > 0 && verbose) {
      check('ok', 'Таблицы', sizes.map((row) => `${row.table_name}: ${row.rows}`).join(', '));
    }
  } catch (error) {
    check(
      'fail',
      'Не удалось прочитать состояние миграций',
      String(error?.message ?? error),
      'pnpm db:deploy',
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port, timeout: 1_500 });
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

async function probe(url) {
  // An explicit controller rather than `AbortSignal.timeout`: the timer is cleared as
  // soon as the request settles, so a finished check never keeps the process alive.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function checkServers() {
  section('4/5  Порты и запущенные серверы');

  const apiPort = Number(process.env.API_PORT ?? 3001);
  const webPort = Number(process.env.WEB_PORT ?? 3000);

  // --- API -----------------------------------------------------------------
  if (await isPortFree(apiPort)) {
    check('ok', `Порт ${apiPort} (API) свободен`, 'сервер не запущен — это нормально');
  } else {
    const health = await probe(`http://127.0.0.1:${apiPort}/api/v1/health/ready`);

    if (!health) {
      check(
        'warn',
        `Порт ${apiPort} занят, но отвечает не AnonLink`,
        null,
        `Закройте программу, которая слушает ${apiPort}, или смените API_PORT в .env`,
      );
    } else if (health.status === 200) {
      check('ok', `AnonLink API уже запущен на порту ${apiPort}`, JSON.stringify(health.body));
    } else {
      check(
        'warn',
        `AnonLink API запущен на порту ${apiPort}, но не готов`,
        JSON.stringify(health.body),
        'Обычно это значит, что база данных недоступна — смотрите раздел 3.',
      );
    }
  }

  // --- Web -----------------------------------------------------------------
  if (await isPortFree(webPort)) {
    check('ok', `Порт ${webPort} (сайт) свободен`, 'сайт не запущен — это нормально');
  } else {
    const page = await probe(`http://127.0.0.1:${webPort}/`).catch(() => null);
    check(
      page ? 'ok' : 'warn',
      page ? `Сайт уже запущен на порту ${webPort}` : `Порт ${webPort} занят другим приложением`,
      page ? null : undefined,
      page
        ? undefined
        : `Закройте программу, которая слушает ${webPort}, или смените порт: pnpm dev -- --port 3005`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

console.log(`AnonLink — проверка окружения`);
console.log(`Папка проекта: ${REPO_ROOT}`);

checkToolchain();
checkFiles();
await checkDatabase();
await checkServers();

section('5/5  Итог');

const failures = results.filter((result) => result.status === 'fail');
const warnings = results.filter((result) => result.status === 'warn');

if (failures.length === 0 && warnings.length === 0) {
  console.log('  Всё в порядке.');
  console.log('\n  Запустить приложение:  pnpm dev');
  console.log('  Открыть в браузере:    http://localhost:3000');
} else if (failures.length === 0) {
  console.log(`  Готово, но есть ${warnings.length} предупреждение(й) — см. выше.`);
  console.log('\n  Если сайт не открывается, выполните:  pnpm setup');
} else {
  console.log(`  Найдено проблем: ${failures.length}. Что нужно сделать:`);
  for (const failure of failures) console.log(`    - ${failure.title}`);
  console.log('\n  Автоматическое исправление того, что можно исправить:  pnpm setup');
}

process.exitCode = failures.length === 0 ? 0 : 1;

// Deliberately not `process.exit()`: killing the process while libuv still has handles
// closing trips an assertion on Windows. Setting the exit code lets Node finish tidying
// up and exit on its own.
