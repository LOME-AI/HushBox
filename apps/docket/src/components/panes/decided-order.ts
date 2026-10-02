import type { FindingJson } from '@hushbox/docket';

/**
 * When a finding was last decided. Both timestamps are ISO-8601 from the same
 * writer, so they sort as strings and a ruling compares against a denial.
 */
export function actionedAt(finding: FindingJson): string {
  return finding.ruling?.at ?? finding.denial?.at ?? '';
}

/**
 * Most recently decided day first. Moments are day resolution, so everything
 * decided on the same day ties, and `toSorted` is stable — a tie keeps the order
 * it arrived in, which is the order the audit emitted its files. Within a review
 * session, that is most of the list. A finding carrying no moment sorts last
 * rather than being dropped.
 */
export function orderByMostRecentAction(findings: readonly FindingJson[]): readonly FindingJson[] {
  return findings.toSorted((left, right) => actionedAt(right).localeCompare(actionedAt(left)));
}
