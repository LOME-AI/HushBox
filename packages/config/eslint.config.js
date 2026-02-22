// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import noSecrets from 'eslint-plugin-no-secrets';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import pluginPromise from 'eslint-plugin-promise';
import unusedImports from 'eslint-plugin-unused-imports';

/**
 * Creates the base ESLint configuration with correct TypeScript project resolution.
 * @param {string} tsconfigRootDir - Absolute path to the package/app root (use import.meta.dirname)
 * @returns {import('eslint').Linter.Config[]}
 */
export function createBaseConfig(tsconfigRootDir) {
  return [
    {
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.turbo/**',
        '**/coverage/**',
        '**/*.d.ts',
        '**/*.config.js',
        '**/*.config.ts',
        '**/.lintstagedrc.js',
        '**/drizzle.config.ts',
      ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    sonarjs.configs.recommended,
    pluginPromise.configs['flat/recommended'],
    unicorn.configs.recommended,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
    },
    {
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      ...tseslint.configs.disableTypeChecked,
    },
    {
      plugins: {
        'no-secrets': noSecrets,
        'unused-imports': unusedImports,
      },
      rules: {
        // Secret detection (patterns based on env.config.ts)
        'no-secrets/no-secrets': [
          'error',
          {
            tolerance: 4.2,
            additionalRegexes: {
              'GitHub Token': 'gh[pousr]_[A-Za-z0-9_]{36,}',
              'OpenRouter Key': 'sk-or-[a-zA-Z0-9-]+',
              'Resend Key': 're_[a-zA-Z0-9_]+',
              'Helcim Token': 'api-[a-f0-9]{32}',
            },
          },
        ],

        // Cognitive complexity (strict: 10)
        'sonarjs/cognitive-complexity': ['error', 10],

        // Additional complexity limits
        complexity: ['error', { max: 10 }],
        'max-params': ['error', { max: 4 }],
        'max-depth': ['error', { max: 4 }],
        'max-nested-callbacks': ['error', { max: 3 }],

        // Async patterns (all errors, no warnings)
        'promise/no-nesting': 'error',
        'promise/prefer-await-to-then': 'error',

        // Unused imports (replaces @typescript-eslint/no-unused-vars for imports)
        '@typescript-eslint/no-unused-vars': 'off',
        'unused-imports/no-unused-imports': 'error',
        'unused-imports/no-unused-vars': [
          'error',
          {
            vars: 'all',
            varsIgnorePattern: '^_',
            args: 'after-used',
            argsIgnorePattern: '^_',
          },
        ],

        // Console logging - prevents debug logs in production
        // Errors on: console.log(), console.info(), console.debug(), console.trace(), etc.
        // Allows only: console.warn() and console.error() (legitimate error reporting)
        'no-console': ['error', { allow: ['warn', 'error'] }],

        // Unicorn overrides for project conventions
        'unicorn/prevent-abbreviations': [
          'error',
          {
            replacements: {
              props: false,
              params: false,
              args: false,
              ref: false,
              env: false,
              db: false,
              ctx: false,
              req: false,
              res: false,
              err: false,
              val: false,
              dev: false,
              el: false,
              msg: false,
              dir: false,
              e: false,
            },
          },
        ],
        'unicorn/no-null': 'off',
        'unicorn/filename-case': 'off',
        'unicorn/prefer-ternary': 'off',
        'sonarjs/slow-regex': 'off',
      },
    },
  ];
}

/** @type {import('eslint').Linter.Config[]} */
export const testConfig = [
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      // Allow deeper nesting for describe/it/act patterns (standard BDD testing)
      'max-nested-callbacks': ['error', { max: 5 }],

      // Test code often asserts on renderHook results and mock-captured variables
      // that TypeScript narrows to null (control flow can't see mock callbacks)
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Vitest mock functions (vi.fn()) are standalone — not class methods with this binding
      '@typescript-eslint/unbound-method': 'off',

      // Vitest mocks return `any` by design
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // Test fixtures contain fake secrets/passwords/IPs
      'no-secrets/no-secrets': 'off',
      'sonarjs/no-hardcoded-passwords': 'off',
      'sonarjs/no-hardcoded-ip': 'off',
      'sonarjs/no-clear-text-protocols': 'off',

      // Test setup uses nested functions and empty callbacks
      'sonarjs/no-nested-functions': 'off',
      '@typescript-eslint/no-empty-function': 'off',

      // Tests may use Math.random for test data
      'sonarjs/pseudo-random': 'off',

      // Allow helper functions defined in test scope
      'unicorn/consistent-function-scoping': 'off',
    },
  },
  {
    // Integration tests may need CI debug output
    files: ['**/*.integration.test.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const scriptsConfig = [
  {
    // Match all .ts files when running ESLint from scripts directory
    files: ['**/*.ts'],
    rules: {
      // CLI scripts need console output
      'no-console': 'off',
      // Scripts need process.exit for status codes
      'unicorn/no-process-exit': 'off',
      // Scripts use async IIFE pattern with isMain guard
      'unicorn/prefer-top-level-await': 'off',
    },
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const devServicesConfig = [
  {
    // Dev-only services that intentionally log to console
    files: ['**/services/**/mock*.ts', '**/services/email/console.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const reactConfig = [
  {
    files: ['**/*.{jsx,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs['jsx-runtime'].rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/prop-types': 'off',
    },
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const nodeConfig = [
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const workersConfig = [
  {
    languageOptions: {
      globals: {
        ...globals.worker,
        ...globals.serviceworker,
      },
    },
  },
];

/** @type {import('eslint').Linter.Config} */
export const prettierConfig = eslintPluginPrettierRecommended;
