import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: process.env.MC_BASE_URL ?? 'http://localhost:3747',
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
  projects: [
    {
      name: 'mobile-chrome',
      use: {
        ...devices['Pixel 7'],
        // Override with iPhone 15 dimensions for better iOS approximation
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
    },
    {
      name: 'desktop-chrome',
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
  // Use the already-running server — don't start a new one
  webServer: {
    command: 'npm run dev:lan',
    url: 'http://localhost:3747',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
