import { defineConfig } from '@playwright/test';

const ARTIFACTS = process.env.ARTIFACTS_DIR || '/artifacts';

export default defineConfig({
  testDir: './specs',
  outputDir: `${ARTIFACTS}/test-results`,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: `${ARTIFACTS}/playwright-report.json` }],
  ],
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },
});
