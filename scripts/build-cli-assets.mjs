import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readdir } from 'node:fs/promises';

// Each layer keeps its prompts beside it, in src/<layer>/prompts/.
for (const layer of await readdir('src', { withFileTypes: true })) {
  const folder = `src/${layer.name}/prompts`;
  if (!layer.isDirectory() || !existsSync(folder)) continue;
  await mkdir(`dist-cli/${layer.name}/prompts`, { recursive: true });
  for (const name of await readdir(folder))
    if (name.endsWith('.md'))
      await copyFile(
        `${folder}/${name}`,
        `dist-cli/${layer.name}/prompts/${name}`,
      );
}
await mkdir('dist-cli/desk/vendor', { recursive: true });

for (const [source, target] of [
  ['src/desk/desk.css', 'desk.css'],
  ['public/fonts/manrope-variable.ttf', 'manrope.ttf'],
  ['public/fonts/OFL-Manrope.txt', 'OFL-Manrope.txt'],
  ['public/assets/verifold-symbol.webp', 'symbol.webp'],
  // The desk page imports DOMPurify from this path. See src/desk/vendor/purify.d.ts.
  ['node_modules/dompurify/dist/purify.es.mjs', 'vendor/purify.js'],
  ['node_modules/dompurify/LICENSE', 'vendor/purify.LICENSE.txt'],
  // The desk page updates in place with idiomorph. See src/desk/vendor/idiomorph.d.ts.
  ['node_modules/idiomorph/dist/idiomorph.esm.js', 'vendor/idiomorph.js'],
  ['node_modules/idiomorph/LICENSE', 'vendor/idiomorph.LICENSE.txt'],
  // The terminal page imports xterm.js from this path. See src/desk/vendor/xterm.d.ts.
  ['node_modules/@xterm/xterm/lib/xterm.mjs', 'vendor/xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'vendor/xterm.css'],
  ['node_modules/@xterm/xterm/LICENSE', 'vendor/xterm.LICENSE.txt'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.mjs', 'vendor/addon-fit.js'],
  ['node_modules/@xterm/addon-fit/LICENSE', 'vendor/addon-fit.LICENSE.txt'],
]) {
  await copyFile(source, `dist-cli/desk/${target}`);
}

// tsc writes the entry point without the executable bit. A checkout linked with `npm link` runs it directly.
await chmod('dist-cli/cli.js', 0o755);
