import { envModeForStack } from './stack-mode.ts';
import type { StackMode } from './port-plan.js';

/**
 * The repair a developer is handed when a generated port variable is absent.
 *
 * It names the stack because the obvious remedy is wrong for all but one of
 * them: a bare `pnpm generate:env` writes the development stack's files and
 * leaves an end-to-end shell exactly as broken as it was. The flag value comes
 * from {@link envModeForStack} rather than from the stack's own name, which two
 * of the three stacks do not share — and a stack no mode writes is refused
 * there rather than printed as an instruction that errors.
 *
 * Shared rather than written at each guard: every server the end-to-end run
 * starts checks its own generated port and hands back this same sentence, and a
 * second copy is free to keep the mode-blind wording while the first is
 * corrected — which is how the wording outlived its first correction.
 */
export function missingPortVariable(variable: string, stackMode: StackMode): string {
  const envMode = envModeForStack(stackMode);
  return `${variable} is not set for the ${stackMode} stack — run \`pnpm generate:env --mode=${envMode}\` to regenerate that stack's env files`;
}
