import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-cli/**',
      'brand/**',
      'verifold-website/**',
      'node_modules/**',
      '.local/agents/**',
      // The imported reference package uses its own dependencies and validation gate.
      '.agents/skills/node-typescript/assets/validation/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: { '@typescript-eslint/explicit-module-boundary-types': 'error' },
  },
  // Layers. The engine (core) imports only itself. The old manager (legacy)
  // imports the engine. The desk server and the old desk import neither the
  // command line nor its setup. A marked line names the step that removes it.
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./(cli\\.ts$|(cli|desk|legacy|server|ui)/)',
              message: 'core imports only core.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/legacy/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./(cli\\.ts$|(cli|desk|server|ui)/)',
              message: 'legacy imports only core and legacy.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/{desk,server,ui}/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./(cli\\.ts$|cli/)',
              message: 'the desk and its server do not import cli.',
            },
          ],
        },
      ],
    },
  },
);
