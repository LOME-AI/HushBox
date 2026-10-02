import { loadAudit } from '@hushbox/docket';
import { areaFamily } from '../components/shell/logic/filters.ts';
import { sectionSpec } from '../components/shell/logic/sections.ts';
import { auditsRoot } from './deps.ts';
import type { CliDeps } from './deps.ts';
import type { FindingFilters } from './parse-command.ts';
import type { SectionId } from '../components/shell/logic/sections.ts';
import type { Finding, LoadedFinding } from '@hushbox/docket';

interface Selection {
  /** Which audit the findings came out of, for anything that has to name it. */
  readonly auditName: string;
  readonly findings: readonly LoadedFinding[];
}

/** Each admits every finding while its own flag is unset. */
const CHECKS: readonly ((finding: Finding, filters: FindingFilters) => boolean)[] = [
  (finding, filters) => filters.id === null || finding.id === filters.id,
  (finding, filters) => filters.state === null || finding.state === filters.state,
  // Read through the queue's own predicate: `--section` and the console's tabs
  // name the same sets, and a second rule here is how they drift. It is not a
  // spelling of `--state`: Ruled leaves out a blocked finding and Progress keeps
  // it, and Questions is not a state at all.
  (finding, filters) => filters.section === null || sectionSpec(filters.section).holds(finding),
  // Read through the console's own grouping key: `--area` and the console's
  // area rail name the same families, and a second rule here is how they drift.
  (finding, filters) => filters.area === null || areaFamily(finding.area) === filters.area,
  (finding, filters) => filters.progress === null || finding.progress.status === filters.progress,
  (finding, filters) => filters.severity === null || finding.severity === filters.severity,
];

/**
 * A dedicated finding is not ordinary work, so an unscoped listing does not
 * offer it. Only an unscoped one: a named section resolves through that
 * section's own predicate and nothing else, which is what keeps `--section=X`
 * and the console's X tab holding the same findings by construction rather
 * than by two rules that happen to agree. Open and Ruled still leave a
 * dedicated finding out, through their own `undedicated()` wrapper; Blocked,
 * Questions and Progress still keep it. A finding named by `--id` is never
 * skipped either.
 *
 * What the skip is for is intake, and answering a question is not taking the
 * work on, so an action reading one queue names it in `keptQueue` and that
 * queue's own membership outlives the skip. Sitting here rather than in each
 * action is what stops a listing and a census answering differently.
 */
function offered(finding: Finding, filters: FindingFilters, keptQueue: SectionId | null): boolean {
  if (!finding.dedicated || filters.id !== null || filters.section !== null) return true;
  return keptQueue !== null && sectionSpec(keptQueue).holds(finding);
}

function matchesFilters(
  finding: Finding,
  filters: FindingFilters,
  keptQueue: SectionId | null
): boolean {
  return offered(finding, filters, keptQueue) && CHECKS.every((check) => check(finding, filters));
}

/**
 * Which findings an action reads, in one place, so a listing and a census of
 * the same flags cannot come to different answers.
 *
 * Null is a refusal already reported: a named finding that does not exist is a
 * mistyped id rather than an empty result, so a handoff never reads as
 * "nothing to do".
 */
export async function selectFindings(
  filters: FindingFilters,
  audit: string | null,
  deps: CliDeps,
  keptQueue: SectionId | null = null
): Promise<Selection | null> {
  const loaded = await loadAudit(auditsRoot(deps), audit ?? undefined);

  if (filters.id !== null && !loaded.findings.some((entry) => entry.finding.id === filters.id)) {
    deps.err(`docket: no finding "${filters.id}" in ${loaded.name}`);
    return null;
  }

  return {
    auditName: loaded.name,
    findings: loaded.findings.filter((entry) => matchesFilters(entry.finding, filters, keptQueue)),
  };
}
