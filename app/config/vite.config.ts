import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

// Config lives under app/config/; paths climb `..` back up to app/.
const APP_ROOT = path.resolve(__dirname, "..");

export default defineConfig({
  plugins: [react()],
  // Vite's `root` is where index.html lives — the client SPA.
  root: path.join(APP_ROOT, "client"),
  resolve: {
    // shadcn primitives live under client/src/components/ui/* and import
    // each other / utils via the conventional `@/*` alias. We also expose
    // `@/lib/utils` for the cn() helper.
    alias: {
      "@": path.join(APP_ROOT, "client/src"),
    },
  },
  // Inline postcss config so we don't need a separate postcss.config.js at
  // the app/ root. Tailwind config lives next to this file in app/config/.
  css: {
    postcss: {
      plugins: [
        tailwindcss({ config: path.join(__dirname, "tailwind.config.js") }),
        autoprefixer(),
      ],
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
  build: {
    outDir: path.join(APP_ROOT, "dist/client"),
    emptyOutDir: true,
  },
});
