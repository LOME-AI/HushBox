import type { StackMode } from './port-plan.js';
import type { EnvMode } from '@hushbox/shared';

/**
 * The variable naming the env mode a command runs under. `generate-env` writes
 * it into every stack's own scripts file, so once the first file is loaded the
 * mode carries into every nested invocation without anyone re-stating it.
 *
 * It carries an env mode rather than a stack because a mode answers both
 * questions a reader has — which stack's files to load, and which values a
 * build bakes — while a stack answers only the first, and the one mode that
 * runs no stack is unspellable in a stack's vocabulary.
 */
export const ENV_MODE_VARIABLE = 'HB_ENV_MODE';

/** What an env mode is to the stacks. */
interface EnvModeStack {
  /** The stack whose ports, data plane and generated files the mode resolves. */
  readonly stack: StackMode;
  /**
   * Whether this is the mode a developer regenerates the stack under, rather
   * than one that only stands in for that stack: a CI runner holds one checkout
   * and production binds nothing locally, so neither is a mode anyone
   * regenerates a stack under. Every mode's generated files carry the
   * generating checkout's own slot — its ports and its compose project alike —
   * so what this decides is which single mode owns writing a stack's files —
   * the answer {@link envModeForStack} returns.
   */
  readonly perCheckout: boolean;
  /**
   * Whether the mode runs the stack it names — takes its ports and its data
   * plane, writes its backend and scripts files, and builds a frontend under
   * its name. Production names a stack only because every mode resolves a port
   * allocation from one; nothing is started or bound under it, so writing that
   * stack's files would put production values over a running local
   * environment, and its frontend file is named for the mode instead.
   */
  readonly runsItsStack: boolean;
}

/**
 * Which stack each env mode resolves, and which of them writes that stack for a
 * checkout. Keyed by every env mode, so a mode added to the registry and left
 * out here fails to compile rather than resolving a stack by default.
 *
 * Exactly one mode per stack is per-checkout, which is what makes
 * {@link envModeForStack} an answer rather than a choice — and what makes
 * `pnpm test` a run of its own stack rather than a second tenant of the one
 * `pnpm dev` is using.
 */
const STACK_BY_ENV_MODE: Record<EnvMode, EnvModeStack> = {
  development: { stack: 'development', perCheckout: true, runsItsStack: true },
  test: { stack: 'test', perCheckout: true, runsItsStack: true },
  ciVitest: { stack: 'test', perCheckout: false, runsItsStack: true },
  e2e: { stack: 'e2e', perCheckout: true, runsItsStack: true },
  ciE2E: { stack: 'e2e', perCheckout: false, runsItsStack: true },
  production: { stack: 'development', perCheckout: false, runsItsStack: false },
};

/** The stack an env mode's ports, data plane and generated files belong to. */
export function stackModeFor(mode: EnvMode): StackMode {
  return STACK_BY_ENV_MODE[mode].stack;
}

/** Whether a mode's generation writes the backend and scripts files of a stack. */
export function writesStackFiles(mode: EnvMode): boolean {
  return STACK_BY_ENV_MODE[mode].runsItsStack;
}

/**
 * The mode name a frontend build resolves this env mode's values under: the
 * name of the generated file, and the `MODE` the bundle carries.
 *
 * Which file a mode writes is not which stack it runs. A mode that runs a
 * stack answers with that stack's name, so a runner mode and the local sibling
 * it stands in for name one file, and a bundle built for a stack loads the file
 * that stack generated. The mode that runs none answers with itself, so
 * generating it cannot land on a file some stack is reading.
 */
export function frontendModeFor(mode: EnvMode): EnvMode {
  const declared = STACK_BY_ENV_MODE[mode];
  return declared.runsItsStack ? declared.stack : mode;
}

/** Whether the mode is the one a developer regenerates its stack under. */
export function isPerCheckoutMode(mode: EnvMode): boolean {
  return STACK_BY_ENV_MODE[mode].perCheckout;
}

/**
 * The env mode a checkout regenerates a stack under — what
 * `pnpm generate:env --mode=` takes to write that stack's files.
 *
 * It refuses rather than guesses, so a stack added to `STACK_MODES` in
 * `scripts/lib/stack/port-plan.ts` with no mode writing it fails loudly at the
 * first command that needs one, instead of printing an instruction that errors.
 */
export function envModeForStack(stackMode: StackMode): EnvMode {
  const found = (Object.keys(STACK_BY_ENV_MODE) as EnvMode[]).find(
    (mode) => STACK_BY_ENV_MODE[mode].stack === stackMode && STACK_BY_ENV_MODE[mode].perCheckout
  );
  if (found === undefined) {
    throw new Error(
      `No env mode writes the ${stackMode} stack's files, so nothing can regenerate it. Give it one in the env registry.`
    );
  }
  return found;
}

/** Every mode the table declares, which is every mode the registry declares. */
export const ENV_MODES = Object.keys(STACK_BY_ENV_MODE) as EnvMode[];

function isEnvMode(value: string): value is EnvMode {
  return (ENV_MODES as readonly string[]).includes(value);
}

/**
 * The mode a command runs under when nothing names one — the mode whose files
 * carry no suffix, so a command that never heard of the mode split reads
 * exactly the files it always read.
 */
export const DEFAULT_ENV_MODE: EnvMode = 'development';

/**
 * The stack a command loads when it names no mode: the one whose Postgres
 * database keeps the unsuffixed name it has always had.
 */
export const DEFAULT_STACK_MODE: StackMode = stackModeFor(DEFAULT_ENV_MODE);

/**
 * The mode an already-loaded environment names, or `undefined` where it names
 * none.
 *
 * It sits beside the port plan rather than in the wrapper that reads it because
 * a Vite config needs the same answer and cannot import that wrapper: the
 * wrapper reaches an untyped native dependency, which fails the apps' own
 * `tsc --noEmit`. The mode names are taken from {@link STACK_BY_ENV_MODE}'s own
 * keys, so nothing here imports the registry at runtime.
 */
export function envModeFrom(env: NodeJS.ProcessEnv): EnvMode | undefined {
  const requested = env[ENV_MODE_VARIABLE];
  if (requested === undefined || requested === '') return undefined;
  if (!isEnvMode(requested)) {
    throw new Error(
      `with-env: ${ENV_MODE_VARIABLE}="${requested}" names no mode. Valid: ${ENV_MODES.join(', ')}.`
    );
  }
  return requested;
}

/**
 * The mode an already-loaded environment names, answering
 * {@link DEFAULT_ENV_MODE} where it names none. Every reader allowed to answer
 * an absent selector comes through here, so the answer has one site rather
 * than one per caller: {@link stackModeFrom} needs it as a stack and the
 * wrapper's loader needs it as a mode, and two spellings of one fallback can
 * disagree.
 *
 * That default is a deliberate divergence from `docs/CODE-RULES.md`
 * §Environment Detection, which bans branching on whether a variable is set.
 * Requiring it here cannot work, because the requirement would be circular:
 * the variable is written into a stack's generated scripts file, and this
 * answer is what decides which scripts file gets loaded. On a checkout whose
 * files have never been generated there is nothing that could have set it, so
 * a required selector would make the first command of a checkout unrunnable —
 * including the generation that writes the variable. This is the bootstrap's
 * fixed point and the only place an absent selector is answered;
 * {@link envModeFrom} is what a reader outside the bootstrap uses, and
 * `buildEnvMode` refuses absence outright.
 */
export function envModeOrDefault(env: NodeJS.ProcessEnv): EnvMode {
  return envModeFrom(env) ?? DEFAULT_ENV_MODE;
}

/** Which stack an already-loaded environment belongs to. */
export function stackModeFrom(env: NodeJS.ProcessEnv): StackMode {
  return stackModeFor(envModeOrDefault(env));
}
