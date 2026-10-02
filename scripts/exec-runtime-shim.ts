/**
 * Makes the generated shim for the pinned runtime replace its own process.
 *
 * The package manager generates a shell shim for the runtime the manifest
 * pins, and the generated form runs the real binary as a child and hands that
 * child's status back as its own. An operator who kills that shim kills the
 * shell: the runtime survives, reparents, and keeps every socket it holds
 * open, so nothing below it is ever told. Replacing the shell with the runtime
 * removes the extra process, which is what makes the outermost process of a
 * command the one holding its lifeline.
 *
 * Run after every install, because every install regenerates the shim. Nothing
 * here declares a runtime version: the manifest's single declaration is read
 * for the runtime's name, and the shim it names is corrected where it is.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { stagedWrite } from './lib/staged-write.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Where the package manager writes the shims a script reaches a binary by name through. */
const BIN_DIRECTORY = ['node_modules', '.bin'];

/** The word that makes a shell replace itself with the program it runs. */
const REPLACE = 'exec ';

/** The generated shim's last line: the hand-back that keeps the shell alive to make it. */
const STATUS_HANDBACK = 'exit $?';

/** How the generated shim's invocation line ends, passing on the arguments it was given. */
const FORWARDED_ARGUMENTS = '"$@"';

const ManifestShape = z.object({
  devEngines: z.object({ runtime: z.object({ name: z.string() }) }),
});

export interface ShimOptions {
  /** The workspace root holding the manifest and the generated shims. */
  readonly root?: string;
  /** The platform the shim was generated for. */
  readonly platform?: NodeJS.Platform;
}

export interface ShimOutcome {
  readonly kind: 'corrected' | 'already-corrected' | 'untouched';
  /** One line naming what was done, and where nothing was, why. */
  readonly summary: string;
}

/** The runtime the manifest pins, or nothing where it pins none. */
async function declaredRuntime(root: string): Promise<string | undefined> {
  const raw: unknown = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = ManifestShape.safeParse(raw);
  return manifest.success ? manifest.data.devEngines.runtime.name : undefined;
}

/**
 * A file's text, or nothing where there is no such file. Anything else the
 * filesystem says is raised: a shim that is there and unreadable is a broken
 * checkout, and reading it as an absent one would report the hazard corrected.
 */
async function textOf(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The lines of a shell script, without the empty one a trailing newline leaves. */
function linesOf(text: string): string[] {
  const lines = text.split('\n');
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Whether the shim already replaces itself with the runtime it names. */
function replacesItself(text: string): boolean {
  const last = linesOf(text).at(-1) ?? '';
  return last.startsWith(REPLACE) && last.endsWith(FORWARDED_ARGUMENTS);
}

/**
 * The shim with its invocation replacing the shell, or nothing where the text
 * is not the generated form this corrects.
 *
 * Only the last two lines change, so everything the shim exports above them
 * still reaches the runtime. The shape is read off the end rather than matched
 * whole: what identifies the generated form is the hand-back line and the
 * invocation that forwards its arguments, and both survive the package manager
 * changing how it spells the path it runs.
 */
function replacingItself(text: string): string | undefined {
  const lines = linesOf(text);
  if (lines.at(-1) !== STATUS_HANDBACK) return undefined;
  lines.pop();
  const invocation = lines.at(-1);
  if (invocation === undefined) return undefined;
  if (!invocation.endsWith(FORWARDED_ARGUMENTS)) return undefined;
  lines[lines.length - 1] = `${REPLACE}${invocation}`;
  return `${lines.join('\n')}\n`;
}

export async function execRuntimeShim(options: ShimOptions = {}): Promise<ShimOutcome> {
  const root = options.root ?? REPO_ROOT;
  const platform = options.platform ?? process.platform;

  const runtime = await declaredRuntime(root);
  if (runtime === undefined) {
    return {
      kind: 'untouched',
      summary: 'The manifest pins no runtime, so there is no generated shim to correct.',
    };
  }

  const shim = [...BIN_DIRECTORY, runtime].join('/');
  if (platform === 'win32') {
    return {
      kind: 'untouched',
      summary: `${shim} left as generated: what runs on Windows is a command script, and Windows has nothing that replaces a running process.`,
    };
  }

  const file = path.join(root, ...BIN_DIRECTORY, runtime);
  const text = await textOf(file);
  if (text === undefined) {
    return { kind: 'untouched', summary: `There is no ${shim} to correct.` };
  }
  if (replacesItself(text)) {
    return { kind: 'already-corrected', summary: `${shim} already replaces its own process.` };
  }

  const corrected = replacingItself(text);
  if (corrected === undefined) {
    return {
      kind: 'untouched',
      summary: `${shim} is not the generated form this corrects, so it was left as it is.`,
    };
  }

  // A shell runs a script by reading it in pieces and holds how far it has got
  // against the inode rather than against the path, so a correction written
  // over the shim resumes a shell that is part way through it on different
  // bytes, at an offset the corrected form — shorter than what it replaces —
  // need not even reach. Landing it as a new file leaves the old inode whole
  // for whoever already holds it open. The mode is carried across because that
  // new file would otherwise land at whatever the process umask allows, and a
  // shim nothing may execute is worse than one that forks.
  const { mode } = await fs.stat(file);
  await stagedWrite(file, corrected, { mode: mode & 0o777 });
  return {
    kind: 'corrected',
    summary: `${shim} now replaces its own process rather than forking.`,
  };
}

export const COMMAND_LINE = {
  command: 'tsx scripts/exec-runtime-shim.ts',
  summary: "Makes the pinned runtime's generated shim replace its own process.",
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point */
if (isMainModule(import.meta.url)) {
  void runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const outcome = await execRuntimeShim();
    console.log(outcome.summary);
  });
}
/* v8 ignore stop */
