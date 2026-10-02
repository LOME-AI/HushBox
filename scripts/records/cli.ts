/**
 * `pnpm records`: the overlay git directory `.records.git`, which shares this
 * checkout's working tree and tracks only the record files the root
 * `.gitignore`'s records block names — the paths the main repository ignores.
 */
import { readRepositories, type Repositories } from '../configure-git-clone.js';
import { readCommandLine, type CommandSpec, type FlagRecord } from '../lib/cli/command-line.js';
import { isMainModule } from '../lib/cli/is-main.js';
import { runMain } from '../lib/cli/run-main.js';
import { init, restore, save, status, type RecordsContext } from './operations.js';
import { git } from './overlay.js';

const REMOTE = {
  flag: '--remote',
  kind: 'value',
  summary: 'The records repository URL; the recordsRepo of scripts/repositories.json when omitted.',
  placeholder: '<url>',
} as const;

const SUBCOMMANDS = {
  init: {
    command: 'pnpm records init',
    summary: 'Create .records.git with the records repository as origin, then save.',
    flags: [REMOTE],
    positionals: { kind: 'none' },
  },
  status: {
    command: 'pnpm records status',
    summary:
      'Name each record file save would add, change or delete, and whether main is ahead of origin.',
    flags: [],
    positionals: { kind: 'none' },
  },
  save: {
    command: 'pnpm records save',
    summary: 'Commit every record change under the current UTC day and push main to origin.',
    flags: [],
    positionals: { kind: 'none' },
  },
  restore: {
    command: 'pnpm records restore',
    summary:
      'Clone the records repository into .records.git and check main out; refused while any record file exists.',
    flags: [REMOTE],
    positionals: { kind: 'none' },
  },
} as const satisfies Record<string, CommandSpec>;

export const SUBCOMMAND_LINES: Readonly<Record<string, CommandSpec>> = SUBCOMMANDS;

export const COMMAND_LINE = {
  command: 'pnpm records',
  summary: `The records overlay of this checkout. Commands: ${Object.keys(SUBCOMMANDS).join(', ')}.`,
  flags: [],
  positionals: {
    kind: 'many',
    placeholder: '<command>',
    summary: `One of: ${Object.keys(SUBCOMMANDS).join(', ')}. Each takes its own --help.`,
  },
} as const satisfies CommandSpec;

type Verb = keyof typeof SUBCOMMANDS;

type Log = (line: string) => void;

function isVerb(word: string | undefined): word is Verb {
  return word !== undefined && word in SUBCOMMANDS;
}

/** The records repository's clone URL. */
export function recordsRemote(repositories: Repositories): string {
  return `https://github.com/${repositories.recordsRepo}.git`;
}

async function remoteOf(flags: FlagRecord): Promise<string> {
  const given = flags['--remote'];
  return typeof given === 'string' ? given : recordsRemote(await readRepositories());
}

/** One handler per verb, keyed so a verb the grammar gains without one fails to compile. */
const HANDLERS: Readonly<
  Record<Verb, (context: RecordsContext, flags: FlagRecord) => Promise<void>>
> = {
  async init(context, flags) {
    await init({ ...context, remote: await remoteOf(flags) });
  },
  status(context) {
    return status(context);
  },
  save(context) {
    return save(context);
  },
  async restore(context, flags) {
    await restore({ ...context, remote: await remoteOf(flags) });
  },
};

/** One invocation from `cwd`. Prints through `log`; throws on any refusal. */
export async function main(argv: readonly string[], log: Log, cwd: string): Promise<void> {
  const [word, ...rest] = argv;
  const usage = (text: string): void => {
    log(text.replace(/\n$/u, ''));
  };
  if (!isVerb(word)) {
    if (readCommandLine(COMMAND_LINE, argv, usage) === null) return;
    throw new Error(word === undefined ? 'Missing command' : `Unknown command: ${word}`);
  }
  const parsed = readCommandLine(SUBCOMMANDS[word] as CommandSpec, rest, usage);
  if (parsed === null) return;
  const root = await git(cwd, ['rev-parse', '--show-toplevel'], 'find the repository root');
  await HANDLERS[word]({ root, log }, parsed.flags);
}

/* v8 ignore start -- CLI entry point; the verbs are driven through main() */
if (isMainModule(import.meta.url)) {
  await runMain(() =>
    main(
      process.argv.slice(2),
      (line) => {
        process.stdout.write(`${line}\n`);
      },
      process.cwd()
    )
  );
}
/* v8 ignore stop */
