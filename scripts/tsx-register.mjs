import { register } from 'node:module';

// The tests import the app's .tsx files. See tsx-hooks.mjs.
register('./tsx-hooks.mjs', import.meta.url);
