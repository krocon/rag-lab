// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Shared ESLint config for Node/TypeScript packages (api, mcp, shared).
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
  {
    // Release and smoke-test scripts (plain ES modules run by Node, scripts/).
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
        AbortSignal: 'readonly',
        Response: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: { eqeqeq: ['error', 'always'] },
  },
  {
    // MCP server (stdio): stdout belongs to the protocol. Log via src/logger.ts (stderr) only.
    files: ['apps/mcp/src/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'stdout',
          message: 'stdout carries MCP protocol messages; log to stderr (src/logger.ts).',
        },
      ],
    },
  },
);
