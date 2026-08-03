// Playwright config for the Studio UI smoke suite.
//
// Tests run against the local dev server (Vite on :5174, server on :3002).
// We DON'T auto-start the dev server here — assume the user has `npm run
// dev` running in another terminal. Saves 8-12s per test invocation and
// matches the actual loop (Claude makes a change → hot-reload → re-run
// tests).
//
// Auth: every test calls `loginAsYuhang()` in beforeEach, which POSTs to
// /api/auth/login and stuffs the resulting Bearer token + reviewer_id
// into localStorage at the keys the client reads.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "../e2e", // config now lives in config/; specs are at the repo root's e2e/
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // share one dev server; avoid filesystem races on var/
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5174",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
