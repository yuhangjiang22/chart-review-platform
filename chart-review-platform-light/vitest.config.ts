// Vitest config for the light platform.
//
// `npx vitest` runs from the repo root, so the config must live here (the
// Vite *build* config is at config/vite.config.ts and is not auto-loaded by
// vitest). This wires the three things the component tests need:
//   - @vitejs/plugin-react  → JSX automatic runtime (no "React is not defined")
//   - the "@" alias          → resolves "@/components/ui/button" etc. to client/src
//   - jsdom environment      → render() needs a DOM
// and excludes the Playwright e2e specs (which use test.describe from
// @playwright/test and must not be collected by vitest).

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.join(__dirname, "client/src"),
    },
  },
  test: {
    environment: "jsdom",
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
