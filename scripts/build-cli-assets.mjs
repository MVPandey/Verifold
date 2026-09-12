import { copyFile } from 'node:fs/promises';

for (const [source, target] of [
  ['src/cli/desk.css', 'desk.css'],
  ['public/fonts/manrope-variable.ttf', 'manrope.ttf'],
  ['public/fonts/OFL-Manrope.txt', 'OFL-Manrope.txt'],
  ['public/assets/verifold-symbol.webp', 'symbol.webp'],
]) {
  await copyFile(source, `dist-cli/cli/${target}`);
}
