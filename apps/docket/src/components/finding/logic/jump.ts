import { SECTIONS } from '@/components/shell/logic/sections';
import type { SectionId } from '@/components/shell/logic/sections';
import type { FindingJson } from '@hushbox/docket';

interface JumpPatch {
  readonly section: SectionId;
  readonly focus: string;
}

/**
 * Where one finding is shown, read from the finding itself. A write's response
 * carries the finding it produced, so a caller holding one never has to ask the
 * store where it now lives — which is what makes the answer independent of when
 * any snapshot of the store was taken.
 */
export function landingPatch(finding: FindingJson): JumpPatch | null {
  // Only a queue section is a place a single finding can be landed on: a
  // whole-audit section reads the audit at large, so it is never a landing.
  // Membership is asked rather than the state compared, because a section can
  // hold a finding on something other than its state and landing a reader on a
  // pane that does not list the finding is the failure this avoids.
  const section = SECTIONS.find((candidate) => !candidate.wholeAudit && candidate.holds(finding));
  return section === undefined ? null : { section: section.id, focus: finding.id };
}

/** Landing on a finding the caller already holds. */
export function landTo(finding: FindingJson, go: (patch: JumpPatch) => void): void {
  const patch = landingPatch(finding);
  if (patch !== null) go(patch);
}

/**
 * Where a chip or the palette has to send the reader: they name an id, so the
 * store is the only place the finding can come from. Every caller that holds
 * the finding itself uses `landingPatch` instead.
 */
export function jumpPatch(findings: readonly FindingJson[], id: string): JumpPatch | null {
  const target = findings.find((finding) => finding.id === id);
  return target === undefined ? null : landingPatch(target);
}

/**
 * Taking a jump, so that "there is nowhere to go" is decided here rather than
 * at every call site.
 */
export function jumpTo(
  findings: readonly FindingJson[],
  id: string,
  go: (patch: JumpPatch) => void
): void {
  const patch = jumpPatch(findings, id);
  if (patch !== null) go(patch);
}
