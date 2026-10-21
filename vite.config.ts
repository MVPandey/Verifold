import { defineConfig } from 'vite';

// The app builds into the package. The desk server serves it under /app/.
export default defineConfig({
  root: 'src/app',
  base: '/app/',
  publicDir: false,
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: '../../dist-cli/app',
    emptyOutDir: true,
    // The desk's CSP allows no inline scripts, styles or data: URLs.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    target: 'es2023',
  },
});
