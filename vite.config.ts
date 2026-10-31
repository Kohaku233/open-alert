import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./web', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } },
  },
  build: {
    outDir: 'dist/web', emptyOutDir: true,
    rolldownOptions: { output: { codeSplitting: { minSize: 20_000, groups: [
      { name: 'react', test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 30 },
      { name: 'motion', test: /[\\/]node_modules[\\/](?:gsap|@gsap)[\\/]/, priority: 25 },
      { name: 'ui', test: /[\\/]node_modules[\\/](?:@radix-ui|cmdk|sonner|lucide-react)[\\/]/, priority: 20 },
      // ~9 MB of indicator code: its own chunk, fetched only when the chart shows or searches indicators.
      // Its own dependencies (lightweight-charts) stay in their usual chunks, so the page does not import this one eagerly.
      { name: 'indicators', test: /[\\/]node_modules[\\/](?:lightweight-charts-indicators|oakscriptjs)[\\/]/, priority: 40, includeDependenciesRecursively: false },
      { name: 'vendor', test: /[\\/]node_modules[\\/]/, priority: 10 },
    ] } } },
  },
});
