import { rm } from 'node:fs/promises';

// The folder holds only the compiled tests, so the whole folder goes.
await rm(new URL('../.test-build/', import.meta.url), { recursive: true, force: true });
