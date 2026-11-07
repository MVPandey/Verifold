import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The Python package serves the built app, so the build goes into the package. licenses.md
// holds the licenses of the packages that the build bundles, such as React.
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('../src/verifold/web/', import.meta.url)),
    emptyOutDir: true,
    license: { fileName: 'licenses.md' },
  },
});
