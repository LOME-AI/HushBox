/**
 * The gate behind the one sanitizer that stands between model output and the
 * app origin.
 *
 * Mermaid renders model-authored diagram source to SVG which
 * `apps/web/src/components/chat/message/mermaid-diagram.tsx` injects with
 * `dangerouslySetInnerHTML`, on the origin that holds plaintext and the device
 * key. At `securityLevel: 'strict'` mermaid takes its sanitize branch, so
 * DOMPurify is the whole barrier — and DOMPurify arrives only as mermaid's own
 * transitive dependency, under a range wide enough to resolve below any patched
 * version. The workspace override states the floor; this states that the
 * lockfile obeys it, so the barrier cannot be downgraded, and cannot vanish if
 * a future mermaid drops it, without a gate going red.
 */
const FLOOR_PATTERN = /^ {2}dompurify:[ \t]*'?\^?(\d+\.\d+\.\d+)'?[ \t]*$/mu;
const RESOLVED_PATTERN = /^ {2}dompurify@(\d+\.\d+\.\d+):/gmu;

/**
 * Both patterns capture exactly three dot-separated integers, so folding the
 * parts into one number orders two captures without any part being absent.
 */
function rank(version: string): number {
  return version.split('.').reduce((total, part) => total * 1000 + Number(part), 0);
}

/**
 * Returns a message naming what is wrong, or `undefined` when the resolved
 * sanitizer satisfies the declared floor.
 */
export function sanitizerFloorFailure(workspaceYaml: string, lockfile: string): string | undefined {
  const floor = FLOOR_PATTERN.exec(workspaceYaml)?.[1];
  if (floor === undefined) {
    return 'pnpm-workspace.yaml declares no dompurify floor in its overrides block';
  }

  const resolved = [...lockfile.matchAll(RESOLVED_PATTERN)].flatMap((match) => match.slice(1));
  if (resolved.length === 0) {
    return `pnpm-lock.yaml resolves no dompurify, so nothing holds the ${floor} floor`;
  }

  const below = [...new Set(resolved.filter((version) => rank(version) < rank(floor)))];
  if (below.length > 0) {
    const named = below.toSorted((a, b) => rank(a) - rank(b)).join(', ');
    return `pnpm-lock.yaml resolves dompurify ${named}, below the declared ${floor} floor`;
  }

  return undefined;
}
