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
]) {
  await copyFile(source, `dist-cli/cli/${target}`);
}
