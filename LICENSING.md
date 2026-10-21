# License scope

The MIT license in `LICENSE` applies to the Verifold harness and its supporting files:

- `src/cli.ts`, and the source folders `src/cli/`, `src/core/`, `src/desk/`, `src/legacy/`, `src/protocol/`, and `src/server/`.
- The shared CLI dependency `src/ui/dom.ts`.
- The compiled equivalents included in the `verifold` npm package.
- `scripts/`, `tests/`, `.githooks/`, and `.github/`.
- Root package, build, lint, formatting, and validation configuration files.
- `README.md`, `SECURITY.md`, this file, and documentation about the CLI in `docs/`.

The visual brand assets in `public/assets/` are not covered by this MIT grant. Other repository files outside the list above remain reserved unless they contain a separate license notice.

The Manrope font in `public/fonts/` retains its SIL Open Font License. Third-party components retain their own licenses. The npm package includes DOMPurify as `dist-cli/desk/vendor/purify.js` under its Apache License 2.0, with that license in `dist-cli/desk/vendor/purify.LICENSE.txt`. It includes idiomorph as `dist-cli/desk/vendor/idiomorph.js` under its Zero-Clause BSD license, with that license in `dist-cli/desk/vendor/idiomorph.LICENSE.txt`. The npm package also includes xterm.js and its fit add-on as `dist-cli/desk/vendor/xterm.js`, `xterm.css`, and `addon-fit.js` under their MIT licenses, with those licenses beside them. The `marked` dependency and the optional `@lydell/node-pty` dependency keep their MIT licenses.

The MIT grant does not grant rights to Verifold trademarks. The published npm package includes the research desk's bundled brand symbol. That symbol remains reserved. The bundled Manrope font includes its SIL Open Font License.
