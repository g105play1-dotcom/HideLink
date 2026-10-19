// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const ignored = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.next-e2e/**',
  '**/generated/**',
  '**/coverage/**',
  '**/.turbo/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/.results/**',
  '**/*.d.ts',
];

// `eslint-plugin-react-hooks` exposes its rules differently between majors.
// Read them defensively so a plugin bump cannot break the whole lint run.
const reactHooksRules = reactHooks.configs?.recommended?.rules ?? {};

export default tseslint.config(
  { ignores: ignored },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2023,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'object-shorthand': 'error',
    },
  },
  {
    files: ['apps/api/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // NestJS dependency injection reads constructor parameter types from
      // `emitDecoratorMetadata`. Rewriting those imports to `import type` erases
      // them at runtime and silently breaks DI, so the rule is disabled here.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2023 },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooksRules },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.{mjs,cjs,js}', 'tests/e2e/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
