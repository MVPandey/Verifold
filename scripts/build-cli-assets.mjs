import { copyFile, cp, mkdir } from 'node:fs/promises';

await cp('src/cli/prompts', 'dist-cli/cli/prompts', { recursive: true });
await mkdir('dist-cli/cli/vendor', { recursive: true });

for (const [source, target] of [
  ['src/cli/desk.css', 'desk.css'],
  ['public/fonts/manrope-variable.ttf', 'manrope.ttf'],
  ['public/fonts/OFL-Manrope.txt', 'OFL-Manrope.txt'],
  ['public/assets/verifold-symbol.webp', 'symbol.webp'],
  // The desk page imports DOMPurify from this path. See src/cli/vendor/purify.d.ts.
  ['node_modules/dompurify/dist/purify.es.mjs', 'vendor/purify.js'],
  ['node_modules/dompurify/LICENSE', 'vendor/purify.LICENSE.txt'],
  // The terminal page imports xterm.js from this path. See src/cli/vendor/xterm.d.ts.
  ['node_modules/@xterm/xterm/lib/xterm.mjs', 'vendor/xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'vendor/xterm.css'],
  ['node_modules/@xterm/xterm/LICENSE', 'vendor/xterm.LICENSE.txt'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.mjs', 'vendor/addon-fit.js'],
  ['node_modules/@xterm/addon-fit/LICENSE', 'vendor/addon-fit.LICENSE.txt'],
]) {
  await copyFile(source, `dist-cli/cli/${target}`);
}
