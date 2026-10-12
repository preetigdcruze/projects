/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser only ever talks to its own origin. In development Vite proxies /api to the backend; in Docker nginx does.
// No API keys or service URLs are embedded in the bundle.
const backend = process.env.PAYSENSE_BACKEND_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: backend, changeOrigin: true } } },
  preview: { port: 4173, proxy: { '/api': { target: backend, changeOrigin: true } } },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
});
