/**
 * Sweeps client artifacts for production secret values and credential shapes
 * before they are published; any hit fails the step. Each publishing job runs
 * it with the generated `artifact-sweep-env` block bound to the step, which is
 * where the values it looks for come from.
 */
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { sweepArtifacts } from './lib/artifact-sweep/sweep.js';

export const COMMAND_LINE = {
  command: 'pnpm tsx scripts/sweep-shipped-artifacts.ts',
  summary: 'Fails when a client artifact carries a production secret value or a credential shape.',
  flags: [],
  positionals: {
    kind: 'many',
    placeholder: '<dist-dir|app-archive>',
    summary: 'Built directories, or APK, AAB or IPA files, to sweep.',
  },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point; the sweep it runs is tested in lib/artifact-sweep */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const parsed = readCommandLine(COMMAND_LINE, process.argv.slice(2));
    if (parsed === null) return 0;
    const result = await sweepArtifacts(parsed.positionals, { env: process.env });
    for (const line of result.lines) console.error(line);
    return result.failed ? 1 : 0;
  });
}
/* v8 ignore stop */
