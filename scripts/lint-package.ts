import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { ARGUMENT_SEPARATOR } from './lib/cli/argument-separator.js';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { LINT_TOOL_ARGS } from './lib/lint-tool-args.js';
import { asElectedCacheWriter } from './lib/turbo/cache-writer.js';

/**
 * Scoped lint: `pnpm lint:pkg @hushbox/api [turbo flags]`.
 *
 * A wrapper rather than a `turbo lint --filter` script, because pnpm appends the
 * caller's arguments last: the package name would land after any tool argument
 * the script tried to carry, and turbo refuses one before `--filter`. Bare
 * arguments name packages; flags belong to turbo, so `--force` reaches the task
 * runner rather than the linter; anything past a `--` is the linter's and joins
 * the arguments this script already passes it.
 */
export function lintPackageArgs(argv: readonly string[]): string[] {
  const separator = argv.indexOf(ARGUMENT_SEPARATOR);
  const scoping = separator === -1 ? argv : argv.slice(0, separator);
  const extraToolArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const packages = scoping.filter((argument) => !argument.startsWith('-'));
  if (packages.length === 0) {
    throw new Error('lint:pkg: name a package, as in `pnpm lint:pkg @hushbox/api`');
  }
  const turboFlags = scoping.filter((argument) => argument.startsWith('-'));
  return [
    'lint',
    ...packages.map((name) => `--filter=${name}`),
    ...turboFlags,
    ARGUMENT_SEPARATOR,
    ...LINT_TOOL_ARGS,
    ...extraToolArgs,
  ];
}

export async function runLintPackage(argv: readonly string[]): Promise<number> {
  const result = await execa('turbo', lintPackageArgs(argv), { stdio: 'inherit', reject: false });
  return typeof result.exitCode === 'number' ? result.exitCode : 1;
}

/* v8 ignore start -- CLI entry point exercised through the root lint:pkg script */
if (isMainModule(import.meta.url)) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  await runMain(() =>
    asElectedCacheWriter({ rootDir: path.dirname(scriptDir), command: 'lint:pkg' }, () =>
      runLintPackage(process.argv.slice(2))
    )
  );
}
/* v8 ignore stop */
