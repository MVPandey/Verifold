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
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: globals.node },
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
);
