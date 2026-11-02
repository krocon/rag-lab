// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Shared ESLint config for Node/TypeScript packages (api, shared).
 * apps/web extends it with angular-eslint (see apps/web/eslint.config.js).
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/.angular/**', '**/node_modules/**'] },
  {
    files: ['**/*.ts', '**/*.js'],
    extends: [js.configs.recommended, ...tseslint.configs.strict],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
    },
  },
);
