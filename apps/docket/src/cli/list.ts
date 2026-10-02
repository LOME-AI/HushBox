import { formatBrief, formatContestBrief, formatFindingLine } from '@hushbox/docket';
import { selectFindings } from './select-findings.ts';
import type { CliDeps } from './deps.ts';
import type { ListCommand } from './parse-command.ts';
import type { Finding } from '@hushbox/docket';

/**
 * What separates two briefs. Exported because the console's brief route emits
 * the same output, and a second copy of this literal is how the two drift.
 */
export const BRIEF_SEPARATOR = '---';

interface Formatter {
  readonly format: (finding: Finding) => string;
  /** A brief runs to many lines, so one has to be told from the next. */
  readonly separated: boolean;
}

function formatterFor(command: ListCommand): Formatter {
  if (command.contest) return { format: formatContestBrief, separated: true };
  if (command.brief) return { format: formatBrief, separated: true };
  return { format: formatFindingLine, separated: false };
}

/**
 * The line and the brief both come from `@hushbox/docket`, so the console, this
 * CLI and anything else showing a finding show the same thing.
 */
export async function runList(command: ListCommand, deps: CliDeps): Promise<number> {
  const selection = await selectFindings(command, command.audit, deps);
  if (selection === null) return 1;

  const findings = selection.findings.map((entry) => entry.finding);
  if (findings.length === 0) {
    deps.err(`docket: no findings match in ${selection.auditName}`);
    return 0;
  }

  const { format, separated } = formatterFor(command);
  for (const [index, finding] of findings.entries()) {
    if (separated && index > 0) deps.out(BRIEF_SEPARATOR);
    deps.out(format(finding));
  }
  return 0;
}
