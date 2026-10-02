import { runCensus } from './census';
import { formatHelp } from './help';
import { runList } from './list';
import { parseCommand } from './parse-command';
import { runQuestions } from './questions';
import { runValidate } from './validate';
import { runWrite } from './write';
import type { CliDeps } from './deps';
import type { Command } from './parse-command';

/**
 * A refusal names the one thing that was wrong; the whole surface is one command
 * away. Reprinting it here buries the sentence the reader needs in the sentences
 * they did not ask for.
 */
const HELP_HINT = 'docket: run `pnpm docket --help` for the actions and their flags';

export interface DocketDeps extends CliDeps {
  /** Only reached when no action flag is given. */
  startConsole: (argv: readonly string[]) => Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runAction(
  command: Exclude<Command, { kind: 'console' }>,
  deps: CliDeps
): Promise<number> {
  if (command.kind === 'help') {
    deps.out(formatHelp());
    return 0;
  }
  if (command.kind === 'list') return runList(command, deps);
  if (command.kind === 'census') return runCensus(command, deps);
  if (command.kind === 'questions') return runQuestions(command, deps);
  if (command.kind === 'validate') return runValidate(command, deps);
  return runWrite(command, deps);
}

/**
 * The one entry both surfaces come through: an action flag runs the CLI, and
 * anything else is the console, whose own flags are left to the launcher rather
 * than re-interpreted here.
 */
export async function runDocket(argv: readonly string[], deps: DocketDeps): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    deps.err(`docket: ${describe(error)}`);
    deps.err(HELP_HINT);
    return 1;
  }

  if (command.kind === 'console') {
    try {
      await deps.startConsole(argv);
      return 0;
    } catch (error) {
      deps.err(`docket: ${describe(error)}`);
      deps.err(HELP_HINT);
      return 1;
    }
  }

  try {
    return await runAction(command, deps);
  } catch (error) {
    deps.err(`docket: ${describe(error)}`);
    return 1;
  }
}
