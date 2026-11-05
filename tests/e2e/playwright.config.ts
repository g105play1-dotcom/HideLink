import { defineConfig, devices } from '@playwright/test';

import { E2E_WEB_ORIGIN } from './env';

/**
 * End-to-end configuration.
 *
 * Two deliberate differences from a default Playwright setup:
 *
 *  - `workers: 1` and no parallelism. The matchmaking queue is global: two tests
 *    searching at the same time would match with each other's partners. Sequential
 *    execution is a correctness requirement here, not a conservative default.
 *  - `globalSetup`/`globalTeardown` instead of `webServer`, because Playwright starts
 *    `webServer` *before* `globalSetup` — and the API must not boot before the test
 *    database has been migrated.
 */
export default defineConfig({
  testDir: './specs',
  outputDir: './.results/artifacts',

  fullyParallel: false,
  workers: 1,

  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,

  timeout: 90_000,
  expect: { timeout: 15_000 },

  reporter: [['list'], ['html', { outputFolder: '.results/report', open: 'never' }]],

  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',

  use: {
    baseURL: E2E_WEB_ORIGIN,
    locale: 'ru-RU',
    viewport: { width: 1280, height: 900 },
    // Diagnostics on failure only: traces and screenshots are the difference between
    // reading a red test and guessing at it.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // A voice-message test needs a microphone that does not exist on a CI machine. The
    // fake device produces real MediaRecorder output, so the encoding path is exercised
    // for real rather than mocked in the browser.
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
