import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

const APP_ROOT = path.resolve(__dirname, "..");

export default defineConfig({
  plugins: [react()],
  // Resolve test globs from app/ so the patterns stay short.
  root: APP_ROOT,
  resolve: {
    alias: {
      "@": path.join(APP_ROOT, "client/src"),
    },
  },
  test: {
    include: ["server/**/*.test.ts", "scripts/**/*.test.ts", "client/src/**/*.test.{ts,tsx}"],
    environment: "node",
    globals: false,
  },
});
