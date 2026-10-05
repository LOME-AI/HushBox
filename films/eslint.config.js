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
const RANDOM_PROPERTIES = [{ object: 'Math', property: 'random', message: RANDOM_MESSAGE }];

/**
 * Every clock and timer reached as a property. `process.hrtime` also reports
 * `process.hrtime.bigint()`, whose object is that same member expression.
 * @type {{object: string, property: string, message: string}[]}
 */
const CLOCK_PROPERTIES = [
  { object: 'Date', property: 'now', message: CLOCK_MESSAGE },
  { object: 'performance', property: 'now', message: CLOCK_MESSAGE },
  { object: 'AbortSignal', property: 'timeout', message: CLOCK_MESSAGE },
  { object: 'process', property: 'hrtime', message: CLOCK_MESSAGE },
  { object: 'process', property: 'uptime', message: CLOCK_MESSAGE },
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

/** Every clock and timer reached as a global. */
const CLOCK_GLOBALS = [
  { name: 'Date', message: CLOCK_MESSAGE },
  { name: 'performance', message: CLOCK_MESSAGE },
  { name: 'Temporal', message: CLOCK_MESSAGE },
  { name: 'setTimeout', message: CLOCK_MESSAGE },
  { name: 'setInterval', message: CLOCK_MESSAGE },
  { name: 'setImmediate', message: CLOCK_MESSAGE },
  { name: 'requestIdleCallback', message: CLOCK_MESSAGE },
];

/**
 * The Node modules that hand out timers and clocks as imports, which the
 * global bans cannot see. Stated as syntax because `no-restricted-imports` is
 * the base config's, left untouched.
 */
const CLOCK_SYNTAX = ['timers', 'timers/promises', 'perf_hooks']
  .flatMap((name) => [name, `node:${name}`])
  .map((source) => ({
    selector: `ImportDeclaration[source.value='${source}']`,
    message: CLOCK_MESSAGE,
  }));

const FRAME_SYNTAX = [
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

const PORTABLE_MATH_PROPERTIES = TRANSCENDENTALS.map((property) => ({
  object: 'Math',
  property,
  message: PORTABLE_MATH_MESSAGE,
}));

const PORTABLE_MATH_SYNTAX = [
  { selector: "BinaryExpression[operator='**']", message: PORTABLE_MATH_MESSAGE },
  { selector: "AssignmentExpression[operator='**=']", message: PORTABLE_MATH_MESSAGE },
];

/**
 * The three restricted-API rules for one scope: the frame bans always, the
 * clock and timer bans unless the scope runs in Node, the portable-maths bans
 * where audio must be bit-identical.
 * @param {{clocks: boolean, portableMath: boolean}} scope
 * @returns {import('eslint').Linter.RulesRecord}
 */
function determinismRules({ clocks, portableMath }) {
  return {
    'no-restricted-properties': [
      'error',
      ...RANDOM_PROPERTIES,
      ...(clocks ? CLOCK_PROPERTIES : []),
      ...(portableMath ? PORTABLE_MATH_PROPERTIES : []),
    ],
    'no-restricted-globals': [
      'error',
      ...BASE_RESTRICTED_GLOBALS,
      ...(clocks ? CLOCK_GLOBALS : []),
    ],
    'no-restricted-syntax': [
      'error',
      ...FRAME_SYNTAX,
      ...(clocks ? CLOCK_SYNTAX : []),
      ...(portableMath ? PORTABLE_MATH_SYNTAX : []),
    ],
  };
}

/** The trees, and every film's score, whose audio must be bit-identical everywhere. */
const PORTABLE_MATH_TREES = ['engine/audio', 'engine/analyze', 'engine/dmath'];

const DRIVER = '**/*.driver.ts';

/** The trees whose drivers run in the browser and draw frames. */
const BROWSER_DRIVER_TREES = ['engine/look/**', 'engine/visual/**'];

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
      ...determinismRules({ clocks: true, portableMath: false }),
    },
  },
  {
    // A driver outside the browser trees runs in Node, where a timer or clock
    // never reaches a frame: a stall watchdog, a process's own deadline. The
    // drivers under the browser trees draw frames and keep every ban.
    files: [DRIVER],
    ignores: BROWSER_DRIVER_TREES,
    rules: determinismRules({ clocks: false, portableMath: false }),
  },
  {
    // The audio, analysis and portable-maths trees, and every film's score,
    // produce audio that must be bit-identical everywhere. Tests are exempt:
    // they compare against `Math`.
    files: [...PORTABLE_MATH_TREES.map((tree) => `${tree}/**/*.{ts,tsx}`), '**/score.ts'],
    ignores: ['**/*.test.ts', DRIVER],
    rules: determinismRules({ clocks: true, portableMath: true }),
  },
  {
    // A Node driver inside those trees keeps the portable-maths bans.
    files: PORTABLE_MATH_TREES.map((tree) => `${tree}/${DRIVER}`),
    rules: determinismRules({ clocks: false, portableMath: true }),
  },
  prettierConfig,
];
