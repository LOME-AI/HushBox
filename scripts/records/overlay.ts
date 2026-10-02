/**
 * Every git call the records command makes. The overlay is a second git
 * directory sharing the checkout's working tree, so each call names both
 * explicitly, and none inherits a variable that would point git back at the
 * main repository — the command also runs inside the main repository's hooks,
 * where git exports such variables.
 */
import path from 'node:path';
import { execa } from 'execa';

/** The overlay's git directory, at the root of the checkout it shares. */
export const OVERLAY_DIRECTORY = '.records.git';

const REPOSITORY_VARIABLES: ReadonlySet<string> = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);

/** `env` less every variable that names a repository, index or object store. */
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !REPOSITORY_VARIABLES.has(name))
  );
}

export function overlayDirectory(root: string): string {
  return path.join(root, OVERLAY_DIRECTORY);
}

export interface GitResult {
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitOptions {
  /** Written to the call's standard input. */
  readonly input?: string;
  /** Set on top of the calling environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** The exit codes that are not a failure; 0 alone when omitted. */
  readonly accepted?: readonly number[];
}

/** One git call in `cwd`, never rejecting. */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {}
): Promise<GitResult> {
  const { exitCode, stdout, stderr } = await execa('git', [...args], {
    cwd,
    env: { ...childEnvironment(process.env), ...options.env },
    extendEnv: false,
    reject: false,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return { exitCode, stdout, stderr };
}

/** One git call's result, or an error naming `step` when its exit code is not accepted. */
export async function gitResult(
  cwd: string,
  args: readonly string[],
  step: string,
  options: GitOptions = {}
): Promise<GitResult> {
  const accepted: readonly (number | undefined)[] = options.accepted ?? [0];
  const result = await runGit(cwd, args, options);
  if (!accepted.includes(result.exitCode)) {
    throw new Error(`records: ${step} failed: ${result.stderr}`);
  }
  return result;
}

/** One git call's output, or an error naming `step` and carrying git's own message. */
export async function git(
  cwd: string,
  args: readonly string[],
  step: string = args.join(' '),
  options: GitOptions = {}
): Promise<string> {
  const result = await gitResult(cwd, args, step, options);
  return result.stdout;
}

/** The arguments that aim a git call at the overlay with `root` as its work tree. */
export function overlayArguments(root: string): string[] {
  return [`--git-dir=${overlayDirectory(root)}`, `--work-tree=${root}`];
}

/** {@link git} against the overlay. */
export async function overlayGit(
  root: string,
  args: readonly string[],
  step?: string,
  options: GitOptions = {}
): Promise<string> {
  return git(root, [...overlayArguments(root), ...args], step ?? args.join(' '), options);
}
