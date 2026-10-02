import { censusCitations } from '@hushbox/docket';
import { selectFindings } from './select-findings';
import type { CliDeps } from './deps';
import type { CensusCommand } from './parse-command';
import type { CensusTotals, DeadCitation } from '@hushbox/docket';

const ID_WIDTH = 10;

/** What a citation the console resolved to no file at all reads as. */
const UNRESOLVED = '(unresolved)';

function zoneOf(dead: DeadCitation): string {
  return dead.optionId === null ? dead.zone : `${dead.zone} ${dead.optionId}`;
}

function citationLine(dead: DeadCitation): string {
  return `  ${[dead.text, zoneOf(dead), dead.reason, dead.resolvedPath ?? UNRESOLVED].join('  ')}`;
}

function totalsLine(label: string, totals: CensusTotals): string {
  return `${label} citations ${String(totals.citations)}, dead ${String(totals.dead)}, findings ${String(totals.findings)}`;
}

/**
 * The audit is dated and the tree is not, so a citation that resolved when the
 * finding was written can be dead by the time anyone acts on it. This answers
 * which ones, through the same resolution the console itself runs.
 */
export async function runCensus(command: CensusCommand, deps: CliDeps): Promise<number> {
  const selection = await selectFindings(command, command.audit, deps);
  if (selection === null) return 1;

  const census = await censusCitations({ root: deps.repoRoot, findings: selection.findings });

  for (const [index, entry] of census.dead.entries()) {
    const previous = census.dead[index - 1];
    if (previous?.findingId !== entry.findingId) {
      deps.out(`${entry.findingId.padEnd(ID_WIDTH - 1, ' ')} ${entry.state}`);
    }
    deps.out(citationLine(entry));
  }

  if (census.dead.length > 0) deps.out('');
  deps.out(totalsLine('every zone:', census.all));
  deps.out(totalsLine('clickable:', census.clickable));
  deps.out(
    Object.entries(census.byReason)
      .map(([reason, count]) => `${reason} ${String(count)}`)
      .join(', ')
  );
  return 0;
}
