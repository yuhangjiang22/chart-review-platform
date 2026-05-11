// v2's Vite config. Source-of-truth client lives in v1's app/client/
// (symlinked at <v2>/client). Production-wise v2 owns the UI; the
// symlink is just a "v1 stays canonical until we delete it" device.
//
// Proxy targets v2's own HTTP server (port 3002 by default). v2's
// server then either serves the request (v2-native /api/v2/*) or
// proxies it on to v1's :3001 — see ../server/index.ts.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V2_ROOT = path.resolve(__dirname, "..");
const V1_TAILWIND = path.resolve(
  V2_ROOT, "..", "chart-review-platform", "app", "config", "tailwind.config.js",
);

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
      // Reuse v1's tailwind config so the design tokens (oxblood, sage,
      // ochre, etc.) carry across unchanged.
      plugins: [tailwindcss({ config: V1_TAILWIND }), autoprefixer()],
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    // The `client/` directory inside v2 is a symlink to v1's app/client/.
    // Vite's default fs.allow restricts file reads to the project root,
    // which means the symlink target is rejected. Whitelist v1's app
    // dir so symlinked source files load. (Drop this once v2 vendors
    // the client files instead of symlinking.)
    fs: {
      allow: [
        V2_ROOT,
        path.resolve(V2_ROOT, "..", "chart-review-platform"),
      ],
    },
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
