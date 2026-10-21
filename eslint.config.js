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
    files: ['src/core/**/*.ts'],
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
              regex: '^\\.\\./(?!(core|legacy|server|ui|desk)/)',
              message: 'the desk imports core, legacy, server and ui.',
            },
          ],
        },
      ],
    },
  },
  // The protocol is types that the server and the app share. It imports nothing.
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
