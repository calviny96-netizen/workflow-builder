import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@nodes': fileURLToPath(new URL('../../packages/nodes/src/index.ts', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: ['../..'] },
    proxy: { '/api': 'http://127.0.0.1:8787', '/integration': 'http://127.0.0.1:8787' },
  },
});
