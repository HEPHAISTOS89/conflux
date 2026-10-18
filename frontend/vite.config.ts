import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_API_PROXY (e.g. in an untracked .env.local) points the dev proxy at an API on another port.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react()],
    optimizeDeps: { exclude: ['maplibre-gl'] },
    server: { proxy: { '/api': env.VITE_API_PROXY || 'http://127.0.0.1:8000' } },
    build: {
      target: 'es2022',
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes('maplibre-gl')) return 'map';
            if (id.includes('three')) return 'three';
            if (id.includes('gsap')) return 'gsap';
          },
        },
      },
    },
  };
});
