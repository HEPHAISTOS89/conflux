import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('maplibre-gl')) return 'map';
          if (id.includes('three')) return 'three';
          if (id.includes('gsap')) return 'gsap';
        },
      },
    },
  },
});
