/**
 * Which Maestro flows a run gets, how they are spread over its shards, and
 * which of them the run reports back as failed.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const FLOW_DIR = 'mobile-tests/flows';
export const OTA_FLOW = 'mobile-tests/flows/13-ota-update.yaml';

/**
 * Per-character cost of an `inputText` step relative to one Maestro step.
 * Typing into the Capacitor WebView runs ~10s/char on docker-android (Maestro
 * #2718 — see 10-core-user-flow.yaml), so a typed character costs more wall-
 * clock than a typical step. This is the single global dial for how heavily
 * typing counts toward shard balance; it is not per-flow bookkeeping.
 */
export const INPUT_CHAR_WEIGHT = 2;

function stripQuotes(value: string): string {
  return value.replaceAll(/^['"]|['"]$/g, '');
}

/**
 * Resolve the typed length of an `inputText` value. `${VAR}` references resolve
 * against the flow's own declarations (e.g. `${TEST_USERNAME}` → "tmu") so the
 * count reflects what's actually typed, not the placeholder. An unresolved var
 * falls back to the token's own length.
 */
function resolveInputLength(raw: string, content: string): number {
  const variableName = /^\$\{(\w+)\}$/.exec(raw)?.[1];
  if (variableName !== undefined) {
    const decl = new RegExp(String.raw`^\s*${variableName}:\s*(.+)$`, 'm').exec(content);
    if (decl?.[1] !== undefined) return stripQuotes(decl[1].trim()).length;
    return raw.length;
  }
  return stripQuotes(raw).length;
}

/**
 * Approximate execution cost of a flow, derived entirely from its YAML: the
 * number of steps plus a per-character penalty for `inputText` typing. Adding
 * or editing a flow reweights it automatically — no maintained timing table.
 */
export function flowWeight(content: string): number {
  const separatorIndex = content.search(/^---\s*$/m);
  const body = separatorIndex === -1 ? '' : content.slice(separatorIndex);
  const stepCount = (body.match(/^-\s/gm) ?? []).length;

  let inputChars = 0;
  const inputRegex = /^-\s+inputText:\s*(.+)$/gm;
  let match = inputRegex.exec(body);
  while (match !== null) {
    /* v8 ignore next -- the pattern's one group always participates in a match, so the guard is the compiler's index check rather than a case */
    if (match[1] !== undefined) inputChars += resolveInputLength(match[1].trim(), content);
    match = inputRegex.exec(body);
  }
  return stepCount + inputChars * INPUT_CHAR_WEIGHT;
}

/** Read each flow file and compute its weight. Pure I/O over flowWeight. */
export function weighFlows(flows: string[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const flow of flows) {
    weights.set(flow, flowWeight(readFileSync(flow, 'utf8')));
  }
  return weights;
}

/** Index of the least-loaded shard that still has count capacity. */
function leastLoadedWithCapacity(buckets: string[][], loads: number[], caps: number[]): number {
  let target = -1;
  for (const [index, bucket] of buckets.entries()) {
    /* v8 ignore next -- caps is sized to the bucket count, so every index is in range */
    if (bucket.length >= (caps[index] ?? 0)) continue;
    /* v8 ignore next -- loads is sized to the bucket count, so every index is in range */
    if (target === -1 || (loads[index] ?? 0) < (loads[target] ?? 0)) target = index;
  }
  return target;
}

/**
 * Split flows across n shards so each shard runs a near-equal number of flows
 * (counts differ by at most 1) while keeping total weight per shard as even as
 * possible. Flows are placed heaviest-first onto the least-loaded shard that
 * still has count capacity (count-constrained Longest-Processing-Time). This
 * keeps wall-clock balanced when a few flows dominate; a plain round-robin by
 * filename could pile the two slowest flows onto one shard.
 */
export function partitionByWeight(
  flows: string[],
  n: number,
  weightOf: (flow: string) => number
): string[][] {
  const buckets: string[][] = Array.from({ length: n }, () => []);
  const loads = Array.from({ length: n }, () => 0);
  const caps = Array.from(
    { length: n },
    (_, index) => Math.floor(flows.length / n) + (index < flows.length % n ? 1 : 0)
  );
  const ordered = flows.toSorted((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b));
  for (const flow of ordered) {
    const target = leastLoadedWithCapacity(buckets, loads, caps);
    buckets[target]?.push(flow);
    /* v8 ignore next -- target is a valid bucket index, so loads[target] is always defined */
    loads[target] = (loads[target] ?? 0) + weightOf(flow);
  }
  return buckets;
}

function smokeFlows(): string[] {
  return [`${FLOW_DIR}/01-app-launch.yaml`, `${FLOW_DIR}/03-webview-renders.yaml`];
}

function fullFlowsExcludingOta(): string[] {
  return readdirSync(FLOW_DIR)
    .filter((f) => f.endsWith('.yaml') && f !== path.basename(OTA_FLOW))
    .toSorted((a, b) => a.localeCompare(b))
    .map((f) => `${FLOW_DIR}/${f}`);
}

/* eslint-disable sonarjs/no-selector-parameter -- smoke is the user-facing CLI flag plumbed from parseArgs through main; splitting the caller would just move the same boolean selection one layer up */
export function listFlowsForRun(smoke: boolean): string[] {
  return smoke ? smokeFlows() : fullFlowsExcludingOta();
}
/* eslint-enable sonarjs/no-selector-parameter */
