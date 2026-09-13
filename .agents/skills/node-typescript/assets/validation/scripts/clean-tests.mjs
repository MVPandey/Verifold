import { rm } from 'node:fs/promises';

// This directory contains only test compiler output owned by this template.
await rm(new URL('../.test-build/', import.meta.url), { recursive: true, force: true });
