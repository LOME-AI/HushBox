// @ts-check
import remotion from '@remotion/eslint-plugin';
import {
  BASE_RESTRICTED_GLOBALS,
  BASE_RESTRICTED_SYNTAX,
  createBaseConfig,
  nodeConfig,
  prettierConfig,
} from '@hushbox/config/eslint';

// Every rendered frame is a pure function of the frame number, the film spec and
// the seed, and a film's audio is bit-identical on every machine and Node
// version. These bans are what hold that without review. Flat config replaces
// (never merges) a rule key, so each shared key spreads the base entries first.

const CLOCK_MESSAGE =
  'Films are pure functions of the frame number: derive time from the frame, never from a clock.';
const RANDOM_MESSAGE =
  'Use rand() from engine/rand/rand.ts: every random value is seeded from a key.';
const CSS_MOTION_MESSAGE =
  'CSS animations and transitions run on the wall clock; compute motion from the frame instead.';
const PORTABLE_MATH_MESSAGE =
  'Math transcendentals and ** differ across engines and Node versions; use engine/dmath/dmath.ts.';

/** @type {{object: string, property: string, message: string}[]} */
const RESTRICTED_PROPERTIES = [
  { object: 'Math', property: 'random', message: RANDOM_MESSAGE },
  { object: 'Date', property: 'now', message: CLOCK_MESSAGE },
  { object: 'performance', property: 'now', message: CLOCK_MESSAGE },
];

/** The `Math` functions whose results are not exact under IEEE 754. */
const TRANSCENDENTALS = [
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'exp',
  'expm1',
  'log',
  'log1p',
  'log2',
  'log10',
  'pow',
  'cbrt',
  'hypot',
];

const RESTRICTED_GLOBALS = [
  ...BASE_RESTRICTED_GLOBALS,
  { name: 'Date', message: CLOCK_MESSAGE },
  { name: 'setTimeout', message: CLOCK_MESSAGE },
  { name: 'setInterval', message: CLOCK_MESSAGE },
];

const RESTRICTED_SYNTAX = [
  ...BASE_RESTRICTED_SYNTAX,
  {
    selector: 'Property[key.name=/^(?:animation|transition)(?:$|[A-Z])/]',
    message: CSS_MOTION_MESSAGE,
  },
  {
    selector: 'Property[key.value=/^(?:animation|transition)(?:$|-)/]',
    message: CSS_MOTION_MESSAGE,
  },
  {
    selector: "ImportDeclaration[source.value='remotion'] ImportSpecifier[imported.name='random']",
    message: RANDOM_MESSAGE,
  },
];

/** @type {import('eslint').Linter.Config[]} */
export default [
  // A take under a film's `rounds/` is exploration outside every package gate
  // by the founder's ruling; a film's own `look.ts` and `score.ts` stay linted.
  { ignores: ['*/rounds/**'] },
  ...createBaseConfig(import.meta.dirname),
  ...nodeConfig,
  remotion.flatPlugin,
  {
    rules: {
      // Restated from the recommended set, which ships these at warn: a
      // warn-level rule fails nothing where `--max-warnings` does not reach.
      '@remotion/non-pure-animation': 'error',
      '@remotion/no-object-fit-on-media-video': 'error',
      'no-restricted-properties': ['error', ...RESTRICTED_PROPERTIES],
      'no-restricted-globals': ['error', ...RESTRICTED_GLOBALS],
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],
    },
  },
  {
    // The audio, analysis and portable-maths trees, and every film's score,
    // produce audio that must be bit-identical everywhere. Tests are exempt:
    // they compare against `Math`.
    files: [
      'engine/audio/**/*.{ts,tsx}',
      'engine/analyze/**/*.{ts,tsx}',
      'engine/dmath/**/*.{ts,tsx}',
      '**/score.ts',
    ],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...RESTRICTED_PROPERTIES,
        ...TRANSCENDENTALS.map((property) => ({
          object: 'Math',
          property,
          message: PORTABLE_MATH_MESSAGE,
        })),
      ],
      'no-restricted-syntax': [
        'error',
        ...RESTRICTED_SYNTAX,
        { selector: "BinaryExpression[operator='**']", message: PORTABLE_MATH_MESSAGE },
        { selector: "AssignmentExpression[operator='**=']", message: PORTABLE_MATH_MESSAGE },
      ],
    },
  },
  prettierConfig,
];
