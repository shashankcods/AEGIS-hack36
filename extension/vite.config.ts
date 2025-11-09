// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';
import { resolve } from 'path';   // ✅ new import

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest })
  ],
  base: './',
  build: {
    outDir: 'dist'
  },
  server: {
    port: 5173
  },
  // new alias section
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
