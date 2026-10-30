import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// The Express backend (auth, API, webhook) runs on :3000. In dev we proxy all
// server-owned paths there so the React app at :5173 talks to the real backend.
// The production build emits to ../backend/public, which Express serves.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/login': 'http://localhost:3000',
      '/logout': 'http://localhost:3000',
      '/callback': 'http://localhost:3000',
      '/version.txt': 'http://localhost:3000',
    },
  },
  build: {
    // Express (in ../backend) serves its ./public with an SPA fallback. Build there.
    outDir: '../backend/public',
    emptyOutDir: true,
  },
});
