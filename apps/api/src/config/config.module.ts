import { Global, Module } from '@nestjs/common';

import { APP_CONFIG, loadConfig, type AppConfig } from './env.js';

/**
 * Makes the validated {@link AppConfig} injectable everywhere.
 *
 * Global on purpose: configuration is needed by nearly every component, and
 * re-importing a config module in each feature module adds noise without value.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
