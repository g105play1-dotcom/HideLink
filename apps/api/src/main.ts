// Must be imported before anything that uses decorators or `reflect-metadata`
// (NestJS dependency injection reads constructor types emitted by TypeScript).
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { LogLevel } from '@nestjs/common';

import { AppModule } from './app.module.js';
import { log } from './common/logger.js';
import { loadConfig } from './config/env.js';
import { ConfiguredSocketIoAdapter } from './realtime/socket-io.adapter.js';

const API_PREFIX = 'api/v1';

/**
 * Boots the API.
 *
 * Configuration is loaded *before* the Nest application is created, so a
 * misconfigured `.env` produces one clear, actionable message instead of a Nest
 * startup stack trace. Every other cross-cutting concern (guard, filter, security
 * headers) is registered through `AppModule` so it applies to the whole app rather
 * than depending on this function being correct.
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();

  const logLevels: LogLevel[] = config.isProduction
    ? ['error', 'warn', 'log']
    : ['error', 'warn', 'log', 'debug'];

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: logLevels,
    // The gateway attaches its handlers synchronously on connection; nothing else
    // is order-sensitive, so buffering logs would only delay diagnosing a failure.
    abortOnError: true,
  });

  // Only trust `X-Forwarded-For` when the operator says a proxy sets it; otherwise
  // a client could forge its own address to escape per-address rate limits.
  app.set('trust proxy', config.TRUST_PROXY ? 1 : false);

  app.setGlobalPrefix(API_PREFIX);

  // Chat messages are capped at 4 kB by the shared schema; this is a generous
  // ceiling that still stops a client from making the server allocate freely.
  app.useBodyParser('json', { limit: '64kb' });
  app.useBodyParser('urlencoded', { limit: '16kb', extended: false });

  app.enableCors({
    origin: [...config.CORS_ORIGINS],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type'],
    maxAge: 600,
  });

  // The WebSocket handshake has its own origin check and payload ceiling.
  app.useWebSocketAdapter(
    new ConfiguredSocketIoAdapter(app, { allowedOrigins: config.CORS_ORIGINS }),
  );

  // Lets `ChatService.onApplicationShutdown` mark live chats as finished on
  // Ctrl+C, a container stop, or a service restart.
  app.enableShutdownHooks();

  await app.listen(config.API_PORT, config.API_HOST);

  log.info('api.listening', {
    url: `http://${config.API_HOST}:${config.API_PORT}/${API_PREFIX}`,
    websocket: `ws://${config.API_HOST}:${config.API_PORT}`,
    environment: config.NODE_ENV,
    envFile: config.envFile ?? 'not found (using process environment)',
    cors: config.CORS_ORIGINS.join(','),
  });
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nAnonLink API failed to start:\n\n${message}\n\n`);
  process.exitCode = 1;
});
