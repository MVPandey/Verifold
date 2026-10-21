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
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
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
  // Layers, as allow-lists: a folder not named here, such as a new src/app,
  // is blocked until a rule allows it. cli may import anything. A marked line
  // names the step of #282 that removes it.
  {
    files: ['src/core/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./(?!core/)',
              message: 'core imports only core.',
            },
          ],
        },
      ],
    },
  },
  // A core folder one level down, such as src/core/lab/, reaches the rest of
  // core with ../. A ../../ path leaves core, or comes back into it the long way.
  {
    files: ['src/core/*/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./\\.\\./',
              message:
                'core imports only core, with ../ from a folder in core.',
            },
          ],
        },
      ],
    },
  },
  // src/core/lab/ splits lab.ts, so nothing in it imports lab.ts back.
  // Each block repeats the patterns before it: a later block replaces them.
  {
    files: ['src/core/lab/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./\\.\\./',
              message:
                'core imports only core, with ../ from a folder in core.',
            },
            {
              regex: '^\\.\\./lab(\\.[jt]s)?$',
              message:
                'src/core/lab/ splits lab.ts, so it does not import lab.ts.',
            },
          ],
        },
      ],
    },
  },
  // The records come first: schema.ts imports only core modules outside src/core/lab/.
  {
    files: ['src/core/lab/schema.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./\\.\\./',
              message:
                'core imports only core, with ../ from a folder in core.',
            },
            {
              regex: '^\\.\\./lab(\\.[jt]s)?$',
              message:
                'src/core/lab/ splits lab.ts, so it does not import lab.ts.',
            },
            {
              regex: '^(?!\\.\\./)',
              message:
                'schema.ts imports only core modules outside src/core/lab/.',
            },
          ],
        },
      ],
    },
  },
  // A deeper core folder has no rule of its own yet, so it may import nothing until one is added.
  {
    files: ['src/core/*/*/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '.',
              message:
                'core folders nest one level deep. Add a layer rule for a deeper folder.',
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
              regex: '^\\.\\./(?!(core|legacy)/)',
              message: 'legacy imports only core and legacy.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/server/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./(?!(core|legacy|desk|ui|server|protocol)/)',
              message:
                'the desk server imports core, legacy, desk, ui and protocol.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/desk/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./(?!(core|legacy|server|ui|desk|protocol)/)',
              message:
                'the desk imports core, legacy, server, ui and protocol.',
            },
          ],
        },
      ],
    },
  },
  // The protocol is types and constants that the server, the desk, and the
  // app share. It imports nothing.
  {
    files: ['src/protocol/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '.',
              message: 'the protocol imports nothing.',
            },
          ],
        },
      ],
    },
  },
  // The new app runs in the browser and reaches Verifold only through the
  // protocol. At any depth it may import its own files, src/protocol/,
  // src/ui/, and React, and nothing from the server, the engine, the old
  // desk, legacy, or the command line.
  {
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(\\.\\./)+(core|server|desk|legacy|cli)(/|$)',
              message:
                'the app imports only its own files, protocol, ui and React.',
            },
            {
              regex: '^(?!\\.{1,2}/|react(-dom)?(/|$))',
              message:
                'the app imports only its own files, protocol, ui and React.',
            },
          ],
        },
      ],
    },
  },
  // The browser loads these modules from the desk's URLs. An import of any
  // other path 404s there, so only ./ and ../ui/ are allowed.
  {
    files: [
      'src/desk/desk-{client,lease,map,motion,terminal,terminals,transcript}.ts',
      'src/ui/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\./|\\.\\./ui/)',
              message: 'a browser module imports only ./ and ../ui/.',
            },
          ],
        },
      ],
    },
  },
);
