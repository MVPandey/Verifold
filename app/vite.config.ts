import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The Python package serves the built app, so the build goes into the package.
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('../src/verifold/web/', import.meta.url)),
    emptyOutDir: true,
  },
});
