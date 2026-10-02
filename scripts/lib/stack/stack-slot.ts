/**
 * The variable naming this checkout's offset in the port plan's slot space,
 * which is also what decides whose stack a command is operating on.
 */
export const STACK_SLOT_VARIABLE = 'HB_STACK_SLOT';

/**
 * The slot this checkout holds, as `pnpm generate:env` wrote it.
 *
 * It sits beside the port plan rather than in either wrapper that reads it, for
 * the reason the stack-mode reader does: the run wrapper and the stack CLI both
 * need this answer, and the wrapper reaches the claim registry and an untyped
 * native dependency that a module this widely shared must not drag along.
 *
 * **There is no default.** A slot is issued by claim, so slot 0 is whichever
 * checkout claimed it first and may well be another one; standing in for an
 * absent variable with a fixed number points a command at a stack it does not
 * own, and the command that most needs the right answer is the wipe that
 * refuses while another run is live on the slot. Absent means unknown, and
 * unknown fails with the one thing that resolves it. Resolving the slot here
 * instead is not open: allocating one is what the claim registry does, and
 * reaching it from here is what the sharing forbids.
 */
export function stackSlotFrom(env: NodeJS.ProcessEnv): number {
  const raw = env[STACK_SLOT_VARIABLE];
  if (raw === undefined) {
    throw new Error(
      `${STACK_SLOT_VARIABLE} is not set, so which stack this command would act on is unknown. ` +
        'Run `pnpm generate:env`, which claims this checkout a slot and writes it.'
    );
  }
  const slot = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(slot) || slot < 0) {
    throw new Error(
      `${STACK_SLOT_VARIABLE}="${raw}" names no slot. Run \`pnpm generate:env\` to rewrite it.`
    );
  }
  return slot;
}
