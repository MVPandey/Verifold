// Node strips TypeScript types but does not compile JSX. These loader hooks
// compile the app's .tsx files for the tests, with the compiler the repository
// already uses. An image that the app imports is its file URL, where the
// build gives its URL on the page. Other files load as before.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Loaded on the first .tsx file, so test files without one do not pay for it. */
let typescript;

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.webp'))
    return {
      format: 'module',
      source: `export default ${JSON.stringify(url)};`,
      shortCircuit: true,
    };
  if (!url.startsWith('file:') || !url.endsWith('.tsx'))
    return nextLoad(url, context);
  typescript ??= (await import('typescript')).default;
  const { outputText } = typescript.transpileModule(
    await readFile(new URL(url), 'utf8'),
    {
      fileName: fileURLToPath(url),
      compilerOptions: {
        module: typescript.ModuleKind.ESNext,
        target: typescript.ScriptTarget.ES2023,
        jsx: typescript.JsxEmit.ReactJSX,
        verbatimModuleSyntax: true,
        inlineSourceMap: true,
      },
    },
  );
  return { format: 'module', source: outputText, shortCircuit: true };
}
