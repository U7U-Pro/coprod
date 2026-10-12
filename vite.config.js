import { defineConfig } from 'vite';

// In development Vite serves the app and forwards the sync socket to the
// Node server (see scripts/dev.mjs).
export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://localhost:3001', ws: true } },
  },
});
