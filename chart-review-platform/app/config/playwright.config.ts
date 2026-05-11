import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const APP_ROOT = path.resolve(__dirname, "..");

export default defineConfig({
  testDir: path.join(APP_ROOT, "e2e"),
  // E2E flow includes a real agent run; one minute can easily not be enough.
  timeout: 5 * 60 * 1000,
  expect: { timeout: 30 * 1000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Use the system Google Chrome instead of downloading Playwright's
        // Chromium build (which the sandbox/network couldn't fetch).
        channel: "chrome",
      },
    },
  ],
  // The dev stack (Vite + tsx server) is started by the test runner outside
  // playwright (concurrently in npm run dev). webServer below brings them up
  // for an isolated `npx playwright test` invocation.
  webServer: {
    command: "./node_modules/.bin/concurrently \"npm:dev:server\" \"npm:dev:client\"",
    cwd: APP_ROOT,
    url: "http://localhost:5173",
    timeout: 60 * 1000,
    reuseExistingServer: true,
    stdout: "ignore",
    stderr: "pipe",
  },
});
