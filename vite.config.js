import { defineConfig } from 'vite';

const backend = process.env.BACKEND || 'http://127.0.0.1:8000';

export default defineConfig({
  root: 'web',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend },
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
});
