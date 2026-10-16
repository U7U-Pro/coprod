import { defineConfig } from 'vite';

// In development Vite serves the app and forwards the sync socket to the
// Node server (see scripts/dev.mjs).
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3001', ws: true },
      '/live': { target: 'ws://localhost:3001', ws: true },
      // Keep the Host header: the server checks that requests come from the page's own origin.
      '/api': { target: 'http://localhost:3001', changeOrigin: false },
      '/samples': 'http://localhost:3001',
    },
  },
});
