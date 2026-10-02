// @ts-check
import { fileURLToPath } from 'node:url';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import noSecrets from 'eslint-plugin-no-secrets';
import { configs as sonarjsConfigs } from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import pluginPromise from 'eslint-plugin-promise';
import unusedImports from 'eslint-plugin-unused-imports';
import importPlugin from 'eslint-plugin-import';
import eslintPluginAstro from 'eslint-plugin-astro';
import playwright from 'eslint-plugin-playwright';
import { loadEslintExtensions } from './eslint-extensions/load-extensions.mjs';
import { crossPlatformRestrictedSyntax } from './eslint-parts/cross-platform-restricted-syntax.mjs';
import { doubleCastRestrictedSyntax, TEST_SUPPORT_GLOBS } from './eslint-parts/escape-hatches.mjs';
import { jsxAccessibilityRestrictedSyntax } from './eslint-parts/jsx-accessibility-restricted-syntax.mjs';
import { TEST_FILE_GLOB } from './test-file-spellings.ts';

// Per-task config-extension slot: every *.config.mjs in eslint-extensions/ is
// appended to createBaseConfig()'s output so extension rules win flat-config
// rule-key replacement for the files they scope. Contract in
// eslint-extensions/README.md. Top-level await is fine here: ESLint loads
// config files through dynamic import, which resolves the whole module graph.
const extensionConfigs = await loadEslintExtensions(new URL('eslint-extensions/', import.meta.url));

// Repo root, derived from this file's location, so the env-registry entry
// below pins to one real path rather than a lookalike in another package.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Secret detection: an entropy heuristic plus the vendor-credential shapes we
 * actually issue. Single source, because the env-registry entry re-lists the
 * rule key and flat config replaces rather than merges a rule key.
 */
const secretDetectionOptions = {
  tolerance: 4.2,
  additionalRegexes: {
    'GitHub Token': 'gh[pousr]_[A-Za-z0-9_]{36,}',
    'OpenRouter Key': 'sk-or-[a-zA-Z0-9-]+',
    'Resend Key': 're_[a-zA-Z0-9_]+',
    'Helcim Token': 'api-[a-f0-9]{32}',
  },
};

/**
 * JS animation libraries banned everywhere: they don't respect
 * prefers-reduced-motion / our accessibility settings out of the box. Single
 * source so the frontend-scoped `no-restricted-imports` block (reactConfig) can
 * re-list them alongside its client-SDK patterns — flat config replaces (never
 * merges) a rule key, so a second `no-restricted-imports` object would silently
 * drop these bans for the files it scopes.
 * @type {{name: string, message: string}[]}
 */
const animationLibraryRestrictedPaths = [
  {
    name: 'gsap',
    message: 'Use CSS animations or framer-motion — they respect accessibility settings.',
  },
  { name: 'animejs', message: 'Use CSS animations or framer-motion.' },
  {
    name: 'motion-one',
    message: 'Use framer-motion — same author, but framer-motion is project standard.',
  },
];

/**
 * Client-side error- and product-analytics SDKs banned from every frontend
 * surface (the trees reactConfig composes into). Capture is backend-only
 * (`docs/CODE-RULES.md` §Telemetry, `docs/ARCHITECTURE.md` §Observability):
 * browser capture sits too close to plaintext, so frontend bugs are debugged
 * from user reports. Today only dependency-absence enforces this; the lint ban
 * makes an accidental install fail at the import site. The api telemetry
 * adapter's own `@sentry/*` import is unaffected — this block never reaches
 * apps/api, and the adapter is separately confined by the no-external-sentry
 * extension.
 *
 * `docs/CODE-RULES.md` §Telemetry cites this block as
 * `lint:no-restricted-imports(client SDKs)`, and the citations test resolves
 * that parenthetical's words against these options — so one message in this
 * list carries both "client" and "SDKs".
 * @type {{group: string[], message: string}[]}
 */
const frontendClientSdkRestrictedPatterns = [
  {
    group: ['@sentry/*'],
    message:
      'No client-side error SDK on the frontend — browser capture sits too close to plaintext. Debug frontend bugs from user reports (docs/CODE-RULES.md §Telemetry).',
  },
  {
    group: ['posthog-js', 'posthog-js/*', 'posthog', 'posthog/*'],
    message:
      'No client-side product-analytics SDK on the frontend — capture is backend-only (docs/CODE-RULES.md §Telemetry).',
  },
  {
    group: ['@amplitude/*', 'mixpanel-browser', '@datadog/browser-*'],
    message:
      'No client-side analytics or error SDKs on the frontend — capture is backend-only (docs/CODE-RULES.md §Telemetry).',
  },
];

/**
 * The frontend `no-restricted-imports` options as one object, so a package that
 * must add a ban of its own re-lists these by spreading instead of dropping
 * them: flat config replaces (never merges) a rule key, and spreading the whole
 * object also survives a key being added here later.
 * @type {{paths: {name: string, message: string}[], patterns: {group: string[], message: string}[]}}
 */
export const frontendRestrictedImports = {
  paths: [...animationLibraryRestrictedPaths],
  patterns: [...frontendClientSdkRestrictedPatterns],
};

/**
 * Makes `import/no-cycle` traverse a TypeScript module graph at all.
 *
 * A resolver alone is not enough: the rule resolves a specifier, then must parse
 * the resolved file to follow its own imports, and that parse is gated on the
 * file's extension being in `import/extensions`. That setting defaults to
 * ['.js', '.mjs', '.cjs'], so on a TypeScript tree every module map came back
 * null — resolution succeeded, traversal never began, and the rule reported
 * clean on real cycles while looking configured and enabled.
 *
 * Spread by createBaseConfig, so every tree that composes it is armed. Exported
 * because the regression guard that proves the two keys are what makes the rule
 * traverse asserts against this object rather than a second copy of it.
 * @type {{'import/extensions': string[], 'import/parsers': Record<string, string[]>}}
 */
export const typescriptImportGraphSettings = {
  'import/extensions': ['.ts', '.cts', '.mts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  'import/parsers': { '@typescript-eslint/parser': ['.ts', '.cts', '.mts', '.tsx'] },
};

/**
 * The repo's console policy, exported because it is stated in more than one place:
 * every tree that withdraws `scriptsConfig`'s blanket exemption does so by putting
 * this rule back over itself. A second copy that drifted from this one would leave
 * those trees enforcing a different console policy than everywhere else, silently
 * and with every gate green — so they import it instead.
 * @type {import('eslint').Linter.RuleEntry}
 */
export const NO_CONSOLE_RULE = ['error', { allow: ['warn', 'error'] }];

/**
 * The base config's `no-restricted-globals` entries. Exported so a package that
 * bans globals of its own spreads these first rather than restating them: flat
 * config replaces (never merges) a rule key, so a package that omitted them
 * would drop the base bans for every file its block matches.
 * @type {{name: string, message: string}[]}
 */
export const BASE_RESTRICTED_GLOBALS = [
  // Accessibility — force use of accessibility-aware animation hook.
  // Raw window.requestAnimationFrame ignores prefers-reduced-motion settings,
  // so animations keep running for users who explicitly opted out of motion.
  {
    name: 'requestAnimationFrame',
    message:
      'Use useAnimationFrame from @hushbox/ui instead — respects accessibility motion settings.',
  },
];

/**
 * The base config's `no-restricted-syntax` selectors: the cross-platform
 * shell-out bans and the double-cast ban. Exported for the reason
 * {@link BASE_RESTRICTED_GLOBALS} is.
 * @type {{selector: string, message: string}[]}
 */
export const BASE_RESTRICTED_SYNTAX = [
  ...crossPlatformRestrictedSyntax,
  ...doubleCastRestrictedSyntax,
];

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
        // Every sibling a build emits beside `dist`: vite writes one per mobile
        // OTA target (`--outDir dist-$platform`) and the marketing site writes
        // `dist-preview`. The family is the unit, matching how `.gitignore`
        // states the same set — this list is keyed on directory NAMES, so a
        // build directory given a new name rejoins the gate silently, which is
        // how a 2.2 MB minified bundle came to be linted with nothing to say so.
        '**/dist-*/**',
        '**/build/**',
        '**/.turbo/**',
        '**/coverage/**',
        // Astro's build cache. Stated here rather than in the one package that
        // has one today, so a second Astro tree inherits the answer on arrival.
        '**/.astro/**',
        // The directory NAME is the whole key — no path, no content, nothing
        // else is matched — so a corpus renamed out of this shape rejoins the
        // lint gate, which it fails on purpose: its source is written invalid.
        '**/__test-fixtures-*__/**',
        '**/src/slices/_template/**',
        '**/*.d.ts',
        // Build/tool configuration is exempt from the application rule set:
        // it is written against third-party plugin APIs, not against our
        // conventions. The exemption is the file's ROLE, not its suffix — a
        // `*.config.ts` under a source tree is application code that merely
        // shares the name. Every package lints with `eslint .` from its own
        // root, so a base-path-relative glob expresses "package-root tool
        // config" exactly; a `**/` prefix instead exempts by basename at any
        // depth, which silently excluded the shared env registry
        // (`packages/shared/src/env/env.config.ts`) from every lint gate.
        '*.config.ts',
        // Astro is the one framework that fixes its content-collection config
        // below the source root, out of the package-root glob's reach.
        '**/src/content.config.ts',
        // There is deliberately no `.config.js` counterpart: those are the
        // ESLint and Prettier configs, which satisfy the rule set they define,
        // and their blanket ignore is what kept this file outside its own gate.
        '**/.lintstagedrc.js',
        '**/drizzle.config.ts',
      ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    sonarjsConfigs.recommended,
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
      // ESLint 9 defaults this to `warn` in flat config, so a disable directive
      // covering a rule that no longer fires survives every linter run that is
      // not passed `--max-warnings=0`. A stale suppression is a claim about the
      // code that has stopped being true, so it fails the build like any other.
      linterOptions: {
        reportUnusedDisableDirectives: 'error',
      },
      plugins: {
        'no-secrets': noSecrets,
        'unused-imports': unusedImports,
        import: importPlugin,
      },
      settings: {
        // import/* rules (notably import/no-cycle) need a resolver that
        // understands the codebase's `.js`-suffixed ESM relative imports
        // (`./foo.js` -> `foo.tsx`). Without one, resolution silently
        // traverses nothing and the cycle guard catches no cycles.
        // `alwaysTryTypes` lets `.d.ts` declarations resolve too; `project`
        // is scoped to the linting package's own tsconfig via tsconfigRootDir.
        // Necessary but NOT sufficient for import/no-cycle — it also needs
        // typescriptImportGraphSettings, spread below.
        'import/resolver': {
          typescript: {
            alwaysTryTypes: true,
            project: tsconfigRootDir,
          },
        },
        ...typescriptImportGraphSettings,
      },
      rules: {
        // Circular dependency guard. A cycle means two modules can't be loaded,
        // tested, or reasoned about independently, and produces order-dependent
        // initialization bugs (a re-exported binding can read as `undefined` if
        // it's touched before the other half of the cycle finishes evaluating).
        // `maxDepth: Infinity` catches indirect cycles, not just direct A↔B.
        // `ignoreExternal` stops traversal into node_modules: cycles through
        // third-party deps aren't ours to fix, and walking them parses
        // un-parseable generated files (e.g. lucide-static's bundled ESM).
        'import/no-cycle': ['error', { maxDepth: Number.POSITIVE_INFINITY, ignoreExternal: true }],

        // Import ordering — enforces the project convention in `docs/CODE-RULES.md` §Imports.
        // Most violations auto-fix with `eslint --fix`.
        'import/order': [
          'error',
          {
            groups: [['builtin', 'external'], 'internal', ['parent', 'sibling', 'index'], 'type'],
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
        'no-secrets/no-secrets': ['error', secretDetectionOptions],

        // Cognitive complexity (strict: 10)
        'sonarjs/cognitive-complexity': ['error', 10],

        // Additional complexity limits
        complexity: ['error', { max: 10 }],
        'max-params': ['error', { max: 4 }],
        'max-depth': ['error', { max: 4 }],
        'max-nested-callbacks': ['error', { max: 3 }],

        // The module cap. Blank and comment lines are not counted, so what it
        // measures is code and the way back under it is a split — deleting a
        // module's documentation moves the number not at all.
        'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }],

        // Async patterns (all errors, no warnings)
        'promise/no-nesting': 'error',
        'promise/prefer-await-to-then': 'error',
        // Restated from the recommended set, which ships them at warn: a
        // warn-level rule reports without failing a linter run that is not
        // passed `--max-warnings=0`, and a package's own `eslint .` and the
        // editor are two such runs. At error severity every path resolves them
        // identically over the files it reads; that equalizes rule set and
        // severity, never coverage.
        'promise/no-callback-in-promise': 'error',
        'promise/no-promise-in-callback': 'error',
        'promise/no-return-in-finally': 'error',
        'promise/valid-params': 'error',

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
        'no-console': NO_CONSOLE_RULE,

        // Force separate `import type { ... }` lines instead of inline `import { type ... }`.
        // `disallowTypeAnnotations: false` keeps `typeof import('./foo.js')` patterns (used
        // by vitest's `importOriginal<typeof import('./mock.js')>()` mock pattern) working.
        // Keeps top-level type and value imports visually distinct so changes to either
        // don't accidentally pull in the other.
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', disallowTypeAnnotations: false },
        ],

        // `docs/CODE-RULES.md` §Type Safety requires an explicit return type on
        // every function declaration and every exported function, and exempts an
        // inline callback whose type its context already fixes. The three options
        // implement that exemption rather than relaxing the rule: each exempts
        // only a position where the type is already fixed by the surrounding
        // expression, the annotated target, or the outer signature.
        '@typescript-eslint/explicit-function-return-type': [
          'error',
          {
            allowExpressions: true,
            allowTypedFunctionExpressions: true,
            allowHigherOrderFunctions: true,
          },
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
        // `checkArrowFunctionBody` is the sub-check whose autofix rewrites `() => undefined` into
        // `() => {}`, changing the return type from `undefined` to `void`. Where a signature
        // requires `T | undefined` that is a type error TypeScript does not report, so the fix
        // silently produces code no gate rejects. The rule's other checks are
        // safe and stay on.
        'unicorn/no-useless-undefined': ['error', { checkArrowFunctionBody: false }],
        'sonarjs/slow-regex': 'off',

        'no-restricted-globals': ['error', ...BASE_RESTRICTED_GLOBALS],

        // Accessibility — block JS animation libraries that don't respect
        // prefers-reduced-motion or our accessibility settings out of the box.
        // framer-motion (project standard) honours MotionConfig + reduced-motion.
        'no-restricted-imports': [
          'error',
          {
            paths: [...animationLibraryRestrictedPaths],
          },
        ],

        // Declared rather than inherited: the stylistic preset carries this
        // rule at severity alone, so the style it enforces is whatever that
        // preset's default happens to be on the day. Naming the style here is
        // what makes the angle-bracket half of the double-cast ban a rule this
        // repository holds rather than one it borrows.
        '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'as' }],

        // Cross-platform shell-out bans and the double-cast ban. Selectors live
        // in eslint-parts/ so config entries that override this rule key for a
        // subset of files can re-list them (flat config replaces, never merges,
        // a rule key).
        'no-restricted-syntax': ['error', ...BASE_RESTRICTED_SYNTAX],
      },
    },
    {
      // A module that exists only so tests can run stands in for types it
      // cannot construct, and the laundered cast is how it says so — the test
      // it serves is what checks the claim. The shell-out bans are re-listed
      // because flat config replaces, never merges, a rule key; dropping them
      // here would exempt test code from those too.
      files: [TEST_FILE_GLOB, ...TEST_SUPPORT_GLOBS],
      rules: {
        'no-restricted-syntax': ['error', ...crossPlatformRestrictedSyntax],
      },
    },
    {
      // A test module's length is the number of cases it states, and a case
      // list is what a suite is: splitting one at a line count moves cases
      // between files without making any of them shorter to read. The scope is
      // the test spelling alone — a test-support module is ordinary code that
      // tests happen to import, and stays capped.
      name: 'module-cap-test-release',
      files: [TEST_FILE_GLOB],
      rules: {
        'max-lines': 'off',
      },
    },
    {
      // JavaScript has no return-type annotation to write, so
      // `explicit-function-return-type` is off by language rather than by
      // exemption: the scope is the file extension, and no function, path or
      // name appears in it. `disableTypeChecked` does not already cover it —
      // that rule is syntactic, not type-aware. Position is load-bearing: last
      // matching config wins, so this block must stay after the one that turns
      // the rule on, or the disable resolves to nothing.
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      ...tseslint.configs.disableTypeChecked,
      rules: {
        ...tseslint.configs.disableTypeChecked.rules,
        '@typescript-eslint/explicit-function-return-type': 'off',
      },
    },
    {
      // The shared env registry is a table of per-mode values whose
      // non-production entries are deliberately random-looking fixtures for
      // the local stack — the entropy heuristic reports the file's reason for
      // existing, prose in its comments included. The vendor-credential
      // regexes stay armed, so the case actually worth catching here, a real
      // production key pasted in beside the fixtures, still fails the gate.
      // basePath pins the glob to the repo root regardless of which package's
      // eslint.config.js consumes this config.
      name: 'env-registry-secret-detection',
      basePath: REPO_ROOT,
      files: ['packages/shared/src/env/env.config.ts'],
      rules: {
        'no-secrets/no-secrets': [
          'error',
          { ...secretDetectionOptions, tolerance: Number.POSITIVE_INFINITY },
        ],
      },
    },
    {
      // This file states the rule set it defines as data, so its own selectors
      // are the densest strings in the repo — the accessibility inline-style
      // ban alternates every style property it covers, which the entropy
      // heuristic reads as a secret. As with the env registry above, only the
      // heuristic is stood down; the vendor-credential regexes stay armed.
      name: 'eslint-config-secret-detection',
      basePath: REPO_ROOT,
      files: ['packages/config/eslint.config.js'],
      rules: {
        'no-secrets/no-secrets': [
          'error',
          { ...secretDetectionOptions, tolerance: Number.POSITIVE_INFINITY },
        ],
      },
    },
    {
      // Scoped by path, never by function name — a name list would exempt any
      // future function that happened to match it, and `routes.ts` is the one
      // manifest file per slice, so the ignored `_template/routes.ts` a new slice
      // is copied from is governed by the same shape rather than by a hidden
      // exemption.
      name: 'inferred-return-types',
      basePath: REPO_ROOT,
      files: [
        'apps/api/src/**/routes.ts',
        'apps/api/src/slices/*/routes/**/*.ts',
        'apps/api/src/app.ts',
        'apps/api/src/whole-app/app.test.ts',
        'apps/api/src/middleware/edge-middleware.integration.test.ts',
        'apps/api/src/slices/account/adapters/stores.ts',
      ],
      rules: {
        '@typescript-eslint/explicit-function-return-type': 'off',
      },
    },
    ...extensionConfigs,
  ];
}

/** @type {import('eslint').Linter.Config[]} */
export const testConfig = [
  {
    files: [TEST_FILE_GLOB],
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
export const reactConfig = [
  {
    // Client-side error/analytics SDK ban for the frontend surfaces. reactConfig
    // composes only into frontend packages, never into apps/api (whose telemetry
    // adapter legitimately imports `@sentry/*`). Covers `.ts` as well as JSX
    // because a client SDK can be imported from a non-component module. The animation-library `paths` are
    // re-listed from the shared const because flat config replaces (never
    // merges) a rule key — omitting them here would drop the base config's
    // animation ban for these files.
    files: ['**/*.{ts,tsx,jsx}'],
    rules: {
      'no-restricted-imports': ['error', frontendRestrictedImports],
    },
  },
  {
    files: ['**/*.{jsx,tsx}'],
    plugins: {
      react: reactPlugin,
      // eslint-plugin-react-hooks publishes `configs.flat` as a namespace of
      // configs, while ESLint's own `Plugin` type requires every member of
      // `configs` to be one config. The plugin is otherwise exactly a `Plugin`,
      // and ESLint reads only `rules` from a registered one, so the conflict is
      // in the published declaration rather than in this registration. The
      // suppression retires itself the moment upstream narrows that member.
      // @ts-expect-error -- eslint-plugin-react-hooks declares `configs.flat` as a namespace of configs, which ESLint's `Plugin` type refuses
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
      // Restated from the spread above for the reason the promise block in
      // createBaseConfig gives: the plugin ships them at warn, and a warn-level
      // rule fails nothing where the flag does not reach.
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/incompatible-library': 'error',
      'react-hooks/unsupported-syntax': 'error',
      // Accessibility — recommended baseline. Strict adds stricter
      // role/interaction rules that produce too many false positives in our
      // codebase (Radix primitives, custom interactive wrappers). Recommended
      // catches the high-signal issues without drowning real bugs.
      ...jsxA11y.flatConfigs.recommended.rules,
      'react/prop-types': 'off',

      // Accessibility — block JSX patterns that bypass user accessibility settings.
      // The `window`/`globalThis`.(request|cancel)AnimationFrame member-form ban
      // lives only in the src-scoped block below (which excludes test/story
      // files), not here: like the bare-name `no-restricted-globals` ban — which
      // matches only bare identifiers, never member expressions — it targets
      // production animation code, not legitimate test global-mocking (a test
      // spying on `globalThis.requestAnimationFrame` to exercise a rAF-using hook
      // is a universally-legitimate pattern the a11y rule must not flag).
      // The base cross-platform shell-out bans are re-listed because flat config
      // replaces (never merges) a rule key — without the spread they would
      // silently vanish for every frontend file this block matches.
      'no-restricted-syntax': [
        'error',
        ...crossPlatformRestrictedSyntax,
        ...jsxAccessibilityRestrictedSyntax,
      ],
    },
  },
  {
    // Component-side test-id discipline: every test-id must come from the typed
    // TEST_IDS registry, never a hardcoded literal.
    // Every package composing reactConfig lints from its own root, so the `src`
    // glob is relative to that root and covers exactly that package's source
    // tree. Test and story files are exempt.
    //
    // Each shared set is spread here as well as in the block above because
    // ESLint's no-restricted-syntax does not merge across config blocks — a
    // second `no-restricted-syntax` for these files would otherwise silently
    // drop it. The rAF member-form ban stays out of them: it lives ONLY here
    // (not in the broader block above) so it applies to production `src` code
    // but never to the test/story files this block excludes, where
    // global-mocking of `requestAnimationFrame` is legitimate.
    //
    // Glob covers `.ts` as well as `.tsx`: the member-form rAF ban must reach
    // plain `.ts` modules (a non-JSX animation file could otherwise write
    // `globalThis.requestAnimationFrame` unpoliced). The JSX-only selectors
    // (img, inline-style, data-testid) simply never match in a `.ts` file.
    // Two exact `.ts` files are exempted — the frame loop itself, which
    // `useAnimationFrame` is built on and a plain script calls directly (the
    // one sanctioned rAF site the ban's message points every other file to),
    // and the demo director's documented one-shot paint gate (a single
    // next-frame await, not an animation loop, so useAnimationFrame does not
    // apply). Exact paths, never a name-shaped wildcard, per the exemption
    // discipline used elsewhere in this file.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      TEST_FILE_GLOB,
      ...TEST_SUPPORT_GLOBS,
      '**/*.stories.*',
      'src/hooks/run-animation-frame-loop.ts',
      'src/demo/director.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...crossPlatformRestrictedSyntax,
        ...doubleCastRestrictedSyntax,
        ...jsxAccessibilityRestrictedSyntax,
        {
          // Member-expression rAF form. Deliberately src-only (see the block
          // header): production animation code is policed, test/story mocks are
          // not — matching the bare-name `no-restricted-globals` ban's intent.
          selector:
            'MemberExpression[object.name=/^(window|globalThis)$/][property.name=/^(request|cancel)AnimationFrame$/]',
          message:
            'Use useAnimationFrame from @hushbox/ui instead — respects accessibility motion settings.',
        },
        {
          // Hardcoded string-literal data-testid attribute.
          selector: "JSXAttribute[name.name='data-testid'] > Literal",
          message: 'No literal data-testid — reference the typed TEST_IDS registry.',
        },
        {
          // Template-literal data-testid with a leading literal segment
          // (e.g. `foo-${x}`). Whole-prefix templates whose first segment is an
          // expression (e.g. `${prefix}-x`) and bare `{identifier}` are allowed.
          selector:
            "JSXAttribute[name.name='data-testid'] > JSXExpressionContainer > TemplateLiteral > TemplateElement.quasis:first-child[value.raw!='']",
          message:
            'No literal data-testid segment — build the id from the typed TEST_IDS registry.',
        },
      ],
    },
  },
];

/**
 * The shared `Input` and `Textarea` ship shadcn's `text-base md:text-sm`, so a
 * field reached straight from the primitive reads at 14px above 768px — the
 * width the docket console is actually used at. `console-fields.tsx` owns that
 * override; reaching past it is how a later field silently ships small.
 * @type {{name: string, importNames: string[], message: string}}
 */
const consoleFieldPrimitives = {
  name: '@hushbox/ui',
  importNames: ['Input', 'Textarea'],
  message:
    'Use ConsoleInput / ConsoleTextarea from src/components/console-fields — the shared Input and Textarea drop to 14px above 768px.',
};

/**
 * The console-field ban, composed only by apps/docket. It lives here so the
 * rule and the test that pins it sit in one package; the `src` globs are
 * relative, so they scope to the source tree of whichever package composes it.
 * @type {import('eslint').Linter.Config[]}
 */
export const docketConsoleFieldConfig = [
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...frontendRestrictedImports,
          paths: [...frontendRestrictedImports.paths, consoleFieldPrimitives],
        },
      ],
    },
  },
  {
    // The one sanctioned importer of the primitives: the wrapper that applies
    // the size override every other docket field inherits. Exact file, so a
    // second module cannot quietly join the exemption.
    files: ['src/components/console-fields.tsx'],
    rules: {
      'no-restricted-imports': ['error', frontendRestrictedImports],
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
    rules: {
      // Extend the a11y lint wall to `.astro` templates. astro-eslint-parser
      // emits JSX-compatible nodes (JSXOpeningElement / JSXAttribute /
      // ObjectExpression) for template markup, so the same raw-<img> and
      // inline-color/font selectors that guard `.tsx` apply verbatim here — an
      // .astro file otherwise sits outside the wall and can ship a raw <img> or
      // inline style the accessibility CSS layer can't override. The base
      // cross-platform shell-out bans are re-listed because flat config replaces
      // (never merges) a rule key, so setting `no-restricted-syntax` here would
      // otherwise drop them for `.astro`. This is astroConfig (composed after
      // reactConfig, whose JSX blocks never match `.astro`), so it is the last
      // word on this rule key for astro files — the double-cast ban included,
      // since a component's frontmatter is TypeScript.
      'no-restricted-syntax': [
        'error',
        ...crossPlatformRestrictedSyntax,
        ...doubleCastRestrictedSyntax,
        {
          selector:
            "JSXAttribute[name.name='style'] Property[key.name=/^(color|backgroundColor|borderColor|fontFamily|fontSize|fill|stroke|background|border|borderTop|borderRight|borderBottom|borderLeft|outline|font|boxShadow)$/]",
          message:
            'Do not set color/font in inline styles. Use Tailwind classes or CSS variables so accessibility settings (contrast, font scaling) can override them.',
        },
        {
          // Astro's idiomatic string form: `style="color: red"`. astro-eslint-parser
          // represents it as a Literal directly under the style JSXAttribute (the
          // JSX-object form nests a JSXExpressionContainer between, so `>` excludes it,
          // and that object's own value-Literals never read "color"/"font"). Without
          // this the string form slips past the inline-color/font wall the object form
          // catches.
          selector: "JSXAttribute[name.name='style'] > Literal[value=/color|font/]",
          message:
            'Do not set color/font in inline styles. Use Tailwind classes or CSS variables so accessibility settings (contrast, font scaling) can override them.',
        },
        {
          selector: "JSXOpeningElement[name.name='img']",
          message: 'Use <Img> from @hushbox/ui (content) or <Logo> (decorative) — never raw <img>.',
        },
      ],
    },
  },
];

/**
 * Playwright E2E lint enforcement.
 *
 * Lives here, not in `e2e/eslint.config.js`, because `eslint-plugin-playwright`
 * resolves from this package (where it is a dependency) but not from `e2e/`.
 * Composed ONLY into the e2e config, so these rules never reach app/unit code.
 *
 * File globs are relative to the e2e package root (the suite lints via
 * `eslint .` with cwd `e2e/`), so `**` matches every e2e file.
 *
 * The plugin is registered explicitly rather than via `flat/recommended` so the
 * enabled rule set is exactly the rule set we intend, with no extra rules
 * leaking in (recommended would turn on rules we don't want).
 *
 * The e2e-wide `no-restricted-syntax` and `no-restricted-imports` blocks
 * supersede the base config's identical rule keys for e2e files (flat config
 * replaces, not merges, a rule key across matching objects). E2E owns these
 * syntax/import bans; the base execa and animation-library bans have no e2e
 * usage to protect.
 *
 * Because flat config replaces (never merges) a rule key, the spec-only block
 * below must re-list the universal e2e selectors alongside its spec-only ones —
 * otherwise the universal bans would silently vanish on `*.spec.ts` files, where
 * they matter most. The shared selectors are defined once and spread into both.
 */

/**
 * E2E `no-restricted-syntax` selectors that apply to every e2e file (specs and
 * helpers/pages/setup alike): timeout literals, literal test-ids, wall-clock
 * waits, serial describes, and direct `@hushbox/db` imports.
 * @type {{selector: string, message: string}[]}
 */
export const e2eUniversalRestrictedSyntax = [
  {
    // (a) numeric literal used as a `timeout:` property value. Matches on `raw`
    // (the source text) not `value`: esquery regex-attribute matching only
    // applies to string values, so `[value=/.../]` silently never matches a
    // numeric literal. `raw` also captures numeric separators (e.g. 30_000).
    selector: "Property[key.name='timeout'] > Literal[raw=/^[0-9][0-9_]*$/]",
    message: 'No inline timeout literals — use a named budget from the timeouts module.',
  },
  {
    // (b) string-literal data-testid as a JSX attribute
    selector: "JSXAttribute[name.name='data-testid'] > Literal",
    message: 'No literal data-testid — reference the typed TEST_IDS registry.',
  },
  {
    // (b) string-literal passed to getByTestId('literal')
    selector: "CallExpression[callee.property.name='getByTestId'] > Literal",
    message: 'No literal test id — reference the typed TEST_IDS registry.',
  },
  {
    // (b) raw `[data-testid="..."]` string selector passed to .locator()
    selector: String.raw`CallExpression[callee.property.name='locator'] > Literal[value=/\[data-testid=/]`,
    message: 'No raw [data-testid="..."] selector — build it from the typed TEST_IDS registry.',
  },
  {
    // (c) setTimeout / setInterval calls
    selector: 'CallExpression[callee.name=/^(setTimeout|setInterval)$/]',
    message: 'No wall-clock waits — gate on app-emitted readiness signals.',
  },
  {
    // (d) test.describe.configure({ mode: 'serial' })
    selector:
      "CallExpression[callee.property.name='configure'] ObjectExpression > Property[key.name='mode'][value.value='serial']",
    message:
      'Keep tests order-independent. A suite that genuinely must serialize needs an inline `eslint-disable-next-line no-restricted-syntax -- serial: <shared state>` justification at the call site.',
  },
  {
    // (d) test.describe.serial — a member expression on the member expression
    // `test.describe`, which is the only spelling Playwright declares; the bare
    // `describe.serial` object is matched too for a runner that publishes one.
    selector:
      "MemberExpression[property.name='serial']:matches([object.name='describe'], [object.property.name='describe'])",
    message:
      'Keep tests order-independent. A suite that genuinely must serialize needs an inline `eslint-disable-next-line no-restricted-syntax -- serial: <shared state>` justification at the call site.',
  },
  {
    // (f) importing @hushbox/db (covers static imports the import ban also catches)
    selector: String.raw`ImportDeclaration[source.value=/^@hushbox\/db(\/.*)?$/]`,
    message: 'Specs must not touch the DB directly — set up state via API/dev endpoints.',
  },
  {
    // (g) Reaching a page's own request context (`page.request.get()`,
    // `authenticatedPage.request.post()`, `this.page.request.get()`) bypasses the
    // single retry mechanism, so a transient saturation drop (5xx envelope or
    // thrown socket hang up) silently isn't retried — the classic way setup
    // flakes enter. The `request`/`authenticatedRequest` fixtures (and every
    // `playwright.request.newContext` the harness creates) are already wrapped by
    // `withRequestRetry`, so use those — or wrap explicitly with
    // `withRequestRetry(page.request)`. A helper's own `this.request` field is
    // expected to already hold a wrapped context, so it is exempt.
    selector:
      "CallExpression[callee.object.type='MemberExpression'][callee.object.property.name='request'][callee.object.object.type!='ThisExpression'][callee.property.name=/^(get|head|post|put|patch|delete|fetch)$/]",
    message:
      'No raw page.request.<method>() — use the wrapped request/authenticatedRequest fixture, or withRequestRetry(page.request), so transient saturation drops are retried.',
  },
  {
    // (h) Hand-rolling a fresh `Idempotency-Key` at a mutating request call site
    // (`headers: { 'Idempotency-Key': crypto.randomUUID() }`) instead of routing
    // through the idempotent-request helpers. Every mutating product route is
    // idempotency-gated (400 IDEMPOTENCY_KEY_REQUIRED); the billing-token test
    // 400'd because a sibling call omitted the header. The helpers mint the key
    // in one place, so a retry re-sends the same key. Intentional fixed-string
    // keys (idempotent-replay tests) use a literal, not crypto.randomUUID(), so
    // they are not matched.
    selector:
      "Property[key.value='Idempotency-Key'] > CallExpression[callee.object.name='crypto'][callee.property.name='randomUUID']",
    message:
      'No hand-rolled Idempotency-Key — route mutating requests through the idempotent-request helpers (idempotentPost/Put/Patch/Delete) so the key is minted once and re-sent on retry.',
  },
  {
    // (i) A context declaring an `extraHTTPHeaders` bag of its own. Playwright
    // copies the running project's bag into newContext options only when the key
    // is absent, so any bag of its own REPLACES the project's — the context
    // silently drops the per-project caller identity the config assigns, and
    // nothing about it looks wrong: the context works and the suite passes,
    // while one dimension of one IP limiter stops being per-project. Matching the
    // property rather than the object literal also catches a bag laundered
    // through a variable.
    //
    // No file and no call site is exempt — there is no allowlist to maintain, and
    // the shared helper's own read of the project bag is a member access rather
    // than a property, so it is not the matched shape. The merge wrapper is
    // recognised by CALLEE NAME: delete that `:not()` and every sanctioned call
    // site errors. Matching on the name has two consequences worth knowing
    // before changing it — importing the wrapper under an alias trips the rule
    // (loud, at the call site), and a local function that merely shares its name
    // passes (silent). Resolving the import instead would need type information
    // this rule deliberately does not carry.
    //
    // The `ArrowFunctionExpression` exclusion drops a function-valued
    // `extraHTTPHeaders` from the match. A context-options bag is an object or
    // an identifier naming one, never a function, so that shape is only ever a
    // `test.extend` declaration overriding the `extraHTTPHeaders` OPTION — the
    // mechanism that supplies the identity to every context a test builds,
    // which is the opposite of a context dropping it. Without the exclusion the
    // rule fires on the one declaration the whole identity depends on.
    selector:
      "ObjectExpression > Property[key.name='extraHTTPHeaders']:not([value.callee.name='withProjectHeaders']):not([value.type='ArrowFunctionExpression']), ObjectExpression > Property[key.value='extraHTTPHeaders']:not([value.callee.name='withProjectHeaders']):not([value.type='ArrowFunctionExpression'])",
    message:
      'No context-owned extraHTTPHeaders bag — it replaces the running project bag and drops the per-project caller identity. Wrap it in withProjectHeaders({ … }) so the project headers merge underneath.',
  },
  {
    // (j) A request method called on a page-derived context with a leading-slash
    // path. Such a context inherits the PAGE context's `baseURL` — the preview
    // server — which answers any unknown path with the SPA's index.html and a
    // 200, so the call never reaches the API and every assertion behind it reads
    // HTML: an `.ok()` check passes vacuously and `.json()` throws on `<!doctype`,
    // taking the rest of the step with it. The retry ban above does not cover
    // this and never did: `withRequestRetry(page.request)` satisfies retry while
    // leaving the base URL wrong, which is how two such call sites passed review.
    //
    // The defect is the COMBINATION, not either half. Passing a page-derived
    // context to a helper that builds `${apiUrl}` URLs is correct and stays
    // legal, as does a relative path on an API-scoped context — so the match
    // requires the page-derived object and the leading slash together. The
    // wrapper arm reaches through `withRequestRetry(...)` only when it wraps a
    // `.request` member: wrapping a context built with `newContext({ baseURL })`
    // yields no `.request` member and is not matched.
    //
    // The second selector is the same defect reached through the mutating
    // helpers in `e2e/helpers/idempotent-request.ts`, where the context is the
    // first argument and the path the second rather than the callee's object and
    // its first argument. Both arms see the context only when it is written at
    // the call site; one laundered through a local variable
    // (`const r = withRequestRetry(page.request)`) is invisible to a syntactic
    // matcher and needs scope resolution a vendored rule would have to carry.
    selector: String.raw`CallExpression[callee.property.name=/^(get|head|post|put|patch|delete|fetch)$/]:matches([callee.object.property.name='request'], [callee.object.callee.name='withRequestRetry'][callee.object.arguments.0.property.name='request']):matches([arguments.0.value=/^\//], [arguments.0.quasis.0.value.raw=/^\//]), CallExpression[callee.name=/^idempotent(Post|Put|Patch|Delete)$/]:matches([arguments.0.property.name='request'], [arguments.0.callee.name='withRequestRetry'][arguments.0.arguments.0.property.name='request']):matches([arguments.1.value=/^\//], [arguments.1.quasis.0.value.raw=/^\//])`,
    message:
      'No leading-slash path on a page-derived request context — it carries the page baseURL (the preview server), so the call never reaches the API. Build an API-scoped context with newContext({ baseURL: apiUrl }) the way e2e/helpers/banner.ts does, or name the origin in the path itself.',
  },
];

/**
 * E2E `no-restricted-imports` patterns that apply to every e2e file (specs and
 * helpers/pages/setup alike). Re-listed in the spec-only block alongside the
 * spec-only `@playwright/test` ban, because flat config replaces (never merges)
 * a rule key per file.
 * @type {{group: string[], message: string}[]}
 */
const e2eUniversalRestrictedImportPatterns = [
  {
    group: ['*settled-expect', '*settled-expect.js'],
    message:
      'No auto-settling expect — a per-assertion settling race is what the readiness signals exist to remove. Gate on the specific app-emitted signal for the state under test.',
  },
  {
    group: ['node:timers', 'node:timers/promises', 'timers', 'timers/promises'],
    message:
      'No timer primitives in e2e — wall-clock waits are banned (an aliased setTimeout evades the syntax rule). Gate on app-emitted readiness signals or a dev endpoint instead of sleeping.',
  },
  {
    group: ['@hushbox/db', '@hushbox/db/*'],
    message: 'Specs must not touch the DB directly — set up state via API/dev endpoints.',
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const playwrightConfig = [
  {
    files: ['**/*.ts'],
    plugins: { playwright },
    rules: {
      'playwright/no-element-handle': 'error',
      'playwright/no-eval': 'error',
      'playwright/no-networkidle': 'error',
      'playwright/no-force-option': 'error',
      'playwright/missing-playwright-await': 'error',
      'playwright/no-focused-test': 'error',

      // Raw CSS/signal/media selectors are confined to the page-object + helper
      // abstraction layer, where this rule is intentionally off; specs get it at
      // error (block below). Positional selection (.first/.last/.nth) is a
      // legitimate, clear pattern in this suite, so it is not restricted.
      'playwright/no-raw-locators': 'off',

      // Every async assertion awaited; no floating promises in test flow.
      '@typescript-eslint/no-floating-promises': 'error',

      'playwright/no-wait-for-timeout': 'error',
      'playwright/no-skipped-test': 'error',

      // Point-in-time reads used as assertions are banned; only web-first
      // retrying assertions are allowed.
      'playwright/prefer-web-first-assertions': 'error',

      // Ban implicit per-assertion settling: explicit quiescence only.
      // @hushbox/db ban enforces isolation.
      'no-restricted-imports': [
        'error',
        {
          patterns: [...e2eUniversalRestrictedImportPatterns],
        },
      ],
    },
  },
  {
    // Specs must select via semantic locators or page-object methods. Raw
    // CSS/signal selectors belong in the page-object/helper layer (off above),
    // not in specs. Contract tests assert raw signal attributes by design, so
    // they are excluded.
    files: ['**/*.spec.ts'],
    ignores: ['**/contracts/**'],
    plugins: { playwright },
    rules: {
      'playwright/no-raw-locators': 'error',
    },
  },
  {
    // Universal e2e syntax bans. Applies to every e2e file EXCEPT specs, which
    // get the superset block below (flat config replaces this key for
    // *.spec.ts, so the spec block re-lists these).
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...e2eUniversalRestrictedSyntax],
    },
  },
  {
    // Spec bans = universal bans + spec-only bans. The spec-only additions:
    // deterministic data, spec-scoped so legitimate logging
    // `new Date().toISOString()` in fixtures stays valid; and cleanup hooks,
    // afterEach/afterAll banned in specs only since setup files legitimately use
    // lifecycle hooks. The universal selectors are re-listed because flat config
    // replaces (never merges) this rule key per file.
    files: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...e2eUniversalRestrictedSyntax,
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'No Math.random in specs — use deterministic, seeded data. Control randomness at the fixture boundary.',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'No bare new Date() in specs — pass an explicit timestamp or use page.clock for deterministic time.',
        },
        {
          // Playwright declares both hooks as methods on its `test` object, so
          // `test.afterEach(...)` is the spelling a spec can write; a bare
          // identifier is matched too for a runner that publishes one.
          selector:
            'CallExpression:matches([callee.name=/^(afterEach|afterAll)$/], [callee.property.name=/^(afterEach|afterAll)$/])',
          message: 'No afterEach/afterAll in specs — clean up via fixture teardown instead.',
        },
      ],
      // Specs obtain test/expect (and re-exported Playwright types) from the
      // fixtures module so the suite's guarded page fixtures are in reach; a
      // raw `@playwright/test` import puts them out of reach. The two
      // fixtures modules (e2e/fixtures.ts, e2e/admin/fixtures.ts) legitimately
      // import it and are not specs, so they are outside this glob. Universal
      // import bans are re-listed because flat config replaces (never merges)
      // this rule key for *.spec.ts.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...e2eUniversalRestrictedImportPatterns,
            {
              group: ['@playwright/test'],
              message:
                "Specs must not import @playwright/test directly — import test/expect and the re-exported Page/Locator/Request/Response/APIRequestContext types from the fixtures module (e2e/fixtures.ts, or e2e/admin/fixtures.ts for admin specs) so the suite's guarded page fixtures are in reach.",
            },
          ],
        },
      ],
    },
  },
  {
    // Every test makes ≥1 real assertion. Scoped to specs and
    // excludes setup files, which legitimately lack inline expects. Custom
    // assertion helpers (expect*/assert*/waitFor*/unsettled*) count as assertions.
    files: ['**/*.spec.ts'],
    ignores: ['**/*.setup.ts'],
    plugins: { playwright },
    rules: {
      'playwright/expect-expect': [
        'error',
        {
          // `expectApiErrors` and `expectConsoleErrors`
          // (`e2e/helpers/page-guardrails.ts`) read as assertions and are
          // neither: each registers an allowed-error pattern on the page, so a
          // body whose only call is one of them establishes nothing.
          assertFunctionPatterns: [
            '^expect(?!ApiErrors$|ConsoleErrors$)[A-Z]',
            '^assert[A-Z]',
            '^waitFor[A-Z]',
            '^unsettled',
          ],
        },
      ],
    },
  },
];

/** @type {import('eslint').Linter.Config} */
export const prettierConfig = eslintPluginPrettierRecommended;

/**
 * Lints this package itself: ESLint resolves `eslint .` here to this very
 * file, so without a default export the rule-vendoring package would run with
 * an empty config and sit outside the lint gate. Named exports above stay the
 * factory surface other packages import.
 */
/** @type {import('eslint').Linter.Config[]} */
const eslintConfig = [
  ...createBaseConfig(import.meta.dirname),
  ...nodeConfig,
  ...testConfig,
  prettierConfig,
];

export default eslintConfig;
