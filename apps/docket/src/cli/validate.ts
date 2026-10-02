import { loadAudit } from '@hushbox/docket';
import { auditsRoot } from './deps';
import type { CliDeps } from './deps';
import type { ValidateCommand } from './parse-command';
import type { FindingIssue, ValidationEntry } from '@hushbox/docket';

function issueLine(entry: ValidationEntry, issue: FindingIssue): string {
  const field = issue.field === null ? '' : ` [${issue.field}]`;
  return `${entry.id}: ${issue.code}${field}  ${issue.message}`;
}

/**
 * The structural set only. Emission rules describe the audit agent's judgement at the
 * moment of emission, not a standing invariant: a reopened finding legitimately keeps the
 * single option it shipped with, and a finding emitted under an earlier version of the
 * contract legitimately keeps the shape it shipped with.
 */
export async function runValidate(command: ValidateCommand, deps: CliDeps): Promise<number> {
  const loaded = await loadAudit(auditsRoot(deps), command.audit ?? undefined);
  const lines = loaded.validation.flatMap((entry) =>
    entry.issues.map((issue) => issueLine(entry, issue))
  );

  if (lines.length === 0) {
    deps.out(`docket: ${String(loaded.findings.length)} findings in ${loaded.name} are valid`);
    return 0;
  }

  for (const line of lines) deps.err(line);
  deps.err(
    `docket: ${String(lines.length)} violations across ${String(loaded.validation.length)} findings in ${loaded.name}`
  );
  return 1;
}
