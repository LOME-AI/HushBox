// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import noSecrets from 'eslint-plugin-no-secrets';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import pluginPromise from 'eslint-plugin-promise';
import unusedImports from 'eslint-plugin-unused-imports';
import importPlugin from 'eslint-plugin-import';
import eslintPluginAstro from 'eslint-plugin-astro';

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
        '**/__test-fixtures-*__/**',
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
        import: importPlugin,
      },
      rules: {
        // Import ordering — enforces the project convention from CODE-RULES.md:
        //   1. External dependencies
        //   2. Internal packages (@hushbox/*)
        //   3. Relative imports
        //   4. Type imports last (complements consistent-type-imports below)
        // Most violations auto-fix with `eslint --fix`.
        'import/order': [
          'error',
          {
            groups: [
              ['builtin', 'external'],
              'internal',
              ['parent', 'sibling', 'index'],
              'type',
            ],
            pathGroups: [
              {
                pattern: '@hushbox/**',
                group: 'internal',
                position: 'before',
              },
              {
                pattern: '@/**',
                group: 'internal',
                position: 'after',
              },
            ],
            pathGroupsExcludedImportTypes: ['type'],
            'newlines-between': 'ignore',
          },
        ],

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

        // Force separate `import type { ... }` lines instead of inline `import { type ... }`.
        // `disallowTypeAnnotations: false` keeps `typeof import('./foo.js')` patterns (used
        // by vitest's `importOriginal<typeof import('./mock.js')>()` mock pattern) working.
        // Keeps top-level type and value imports visually distinct so changes to either
        // don't accidentally pull in the other.
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', disallowTypeAnnotations: false },
        ],

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

        // Accessibility — force use of accessibility-aware animation hook.
        // Raw window.requestAnimationFrame ignores prefers-reduced-motion settings,
        // so animations keep running for users who explicitly opted out of motion.
        'no-restricted-globals': [
          'error',
          {
            name: 'requestAnimationFrame',
            message:
              'Use useAnimationFrame from @hushbox/ui instead — respects accessibility motion settings.',
          },
        ],

        // Accessibility — block JS animation libraries that don't respect
        // prefers-reduced-motion or our accessibility settings out of the box.
        // framer-motion (project standard) honours MotionConfig + reduced-motion.
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'gsap',
                message:
                  'Use CSS animations or framer-motion — they respect accessibility settings.',
              },
              { name: 'animejs', message: 'Use CSS animations or framer-motion.' },
              {
                name: 'motion-one',
                message: 'Use framer-motion — same author, but framer-motion is project standard.',
              },
            ],
          },
        ],

        // Cross-platform — block shell-outs to POSIX-only commands and embedded
        // shells. Use Node fs APIs, scripts/kill-ports.ts, archiver/adm-zip,
        // the 'open' package, native fetch, or dedicated tsx wrappers. Reaches
        // execa(), execSync, execFileSync, spawn, spawnSync.
        //
        // Allowed commands: git, docker, node, pnpm, npm, tsx, wrangler,
        // playwright, vitest, drizzle-kit, etc. — cross-platform tools.
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "CallExpression[callee.name='execa'][arguments.0.type='Literal'][arguments.0.value=/^(rm|mv|cp|mkdir|chmod|chown|lsof|xargs|kill|killall|pkill|grep|sed|awk|tr|cut|find|unzip|zip|stat|yes|touch|tail|head|sudo|sh|bash|zsh|fish|curl|wget|xdg-open)$/]",
            message:
              'Cross-platform: do not execa POSIX-only commands. Use Node fs APIs, scripts/kill-ports.ts, archiver/adm-zip, the open package, native fetch, or a tsx wrapper.',
          },
          {
            selector:
              "CallExpression[callee.name=/^(execFileSync|spawn|spawnSync)$/][arguments.0.type='Literal'][arguments.0.value=/^(rm|mv|cp|mkdir|chmod|chown|lsof|xargs|kill|killall|pkill|grep|sed|awk|tr|cut|find|unzip|zip|stat|yes|touch|tail|head|sudo|sh|bash|zsh|fish|curl|wget|xdg-open)$/]",
            message:
              'Cross-platform: do not invoke POSIX-only commands via execFileSync/spawn. Use Node fs APIs, scripts/kill-ports.ts, archiver/adm-zip, the open package, native fetch, or a tsx wrapper.',
          },
          {
            selector:
              "CallExpression[callee.name='execSync'][arguments.0.type='Literal'][arguments.0.value=/^(rm|mv|cp|mkdir|chmod|chown|lsof|xargs|kill|killall|pkill|grep|sed|awk|tr|cut|find|unzip|zip|stat|yes|touch|tail|head|sudo|sh|bash|zsh|fish|curl|wget|xdg-open)(\\s|$)/]",
            message:
              'Cross-platform: do not execSync POSIX-only shell strings. Use Node APIs or a tsx wrapper.',
          },
        ],
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

      // Tests routinely interleave `vi.mock(...)` calls with imports of the
      // mocked module — strict import ordering breaks that pattern. Source
      // files keep the rule on; only tests opt out.
      'import/order': 'off',

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
      'jsx-a11y': jsxA11y,
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
      // Accessibility — recommended baseline. Strict adds stricter
      // role/interaction rules that produce too many false positives in our
      // codebase (Radix primitives, custom interactive wrappers). Recommended
      // catches the high-signal issues without drowning real bugs.
      ...jsxA11y.flatConfigs.recommended.rules,
      'react/prop-types': 'off',

      // Accessibility — block JSX patterns that bypass user accessibility settings.
      // 1. Inline color/font in style props can't be overridden by the global
      //    accessibility CSS layer (contrast, font-scaling, dyslexia fonts, etc.).
      //    Use Tailwind classes or CSS custom properties so the cascade can win.
      // 2. Raw <img> bypasses our <Img>/<Logo> wrappers, which set
      //    `data-no-invert` for invert-colors mode and enforce alt text typing.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='style'] ObjectExpression > Property[key.name=/^(color|backgroundColor|borderColor|fontFamily|fontSize|fill|stroke)$/]",
          message:
            'Do not set color/font in inline styles. Use Tailwind classes or CSS variables so accessibility settings (contrast, font scaling) can override them.',
        },
        {
          selector: "JSXOpeningElement[name.name='img']",
          message:
            'Use <Img> from @hushbox/ui (content) or <Logo> (decorative) — never raw <img>.',
        },
      ],
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

/** @type {import('eslint').Linter.Config[]} */
export const astroConfig = [
  ...eslintPluginAstro.configs.recommended,
  {
    files: ['**/*.astro'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: true,
      },
    },
  },
];

/** @type {import('eslint').Linter.Config} */
export const prettierConfig = eslintPluginPrettierRecommended;
