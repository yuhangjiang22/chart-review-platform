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
    // Bind all interfaces so an SSH tunnel to the compute node's hostname
    // (e.g. -L 8899:<compute-node>:5174) can reach it. Default (localhost
    // only) refuses forwarded connections on a remote/HPC node.
    host: true,
    // Dev server sits on an internal HPC node behind SSH; accept any Host
    // header so tunnels reaching it by node hostname/IP aren't 403'd by
    // vite 5's host check.
    allowedHosts: true,
    port: 5174,
    strictPort: true,
    // HMR WebSocket: when the dev server is reached through an SSH tunnel /
    // relay on a DIFFERENT external port than 5174 (e.g. -L 8899:<node>:5174),
    // the browser's HMR client must dial back on that external port — otherwise
    // it tries localhost:5174, which on the user's machine may be a *different*
    // local app, and the resulting "connection lost" triggers an endless page
    // reload loop. Set VITE_HMR_CLIENT_PORT to the port you actually browse to.
    // Unset → defaults to 5174 (direct/same-port tunnel), preserving prior behavior.
    // VITE_NO_HMR=1 disables HMR entirely — use when reaching the dev server
    // through a relay/tunnel where the HMR WebSocket can't establish; without
    // it the client falls into a "connection lost → reload" page-refresh loop.
    // Otherwise dial HMR back on VITE_HMR_CLIENT_PORT (the external/tunnel port).
    hmr: process.env.VITE_NO_HMR === "1"
      ? false
      : { clientPort: Number(process.env.VITE_HMR_CLIENT_PORT) || 5174 },
    // On a network filesystem (e.g. NFS/Lustre on HPC) inotify doesn't fire,
    // so HMR never sees edits. Poll so changes hot-reload without a restart.
    watch: { usePolling: true, interval: 400 },
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
