import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // keep files flat so popup ends up as dist/index.html
    outDir: 'dist',
    rollupOptions: {
      // default is fine — popup will be dist/index.html, assets in dist/assets
    }
  }
});
