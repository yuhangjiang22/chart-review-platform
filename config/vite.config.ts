// Vite config for the React Studio client. Root is <repo>/client.
//
// Proxy targets v2's own HTTP server (port 3002 by default). v2's server
// then either serves the request (v2-native /api/...) or falls through
// to v1's :3001 for routes not yet ported — see ../server/index.ts.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V2_ROOT = path.resolve(__dirname, "..");
const TAILWIND_CONFIG = path.join(V2_ROOT, "config", "tailwind.config.js");

export default defineConfig({
  plugins: [react()],
  root: path.join(V2_ROOT, "client"),
  resolve: {
    alias: {
      "@": path.join(V2_ROOT, "client/src"),
    },
  },
  css: {
    postcss: {
      plugins: [tailwindcss({ config: TAILWIND_CONFIG }), autoprefixer()],
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3002",
      "/ws": { target: "ws://localhost:3002", ws: true },
    },
  },
  build: {
    outDir: path.join(V2_ROOT, "dist/client"),
    emptyOutDir: true,
  },
});
