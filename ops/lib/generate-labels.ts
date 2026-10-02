#!/usr/bin/env tsx
/**
 * Generate the GitHub label config consumed by EndBug/label-sync.
 *
 * Reads `ops/manifest.yml` and emits a JSON array of
 * `{ name, description, color }` entries. The sync workflow
 * (`.github/workflows/sync-ops-labels.yml`) pipes this into label-sync,
 * which idempotently creates/updates the matching labels in the repo.
 *
 * Standalone CLI: `pnpm tsx ops/lib/generate-labels.ts > /tmp/labels.json`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

/** GitHub's hard cap on label-description length. */
const GITHUB_LABEL_DESCRIPTION_MAX = 100;

/**
 * Amber hex — distinguishes ops labels from regular category/status labels
 * at a glance in the PR labels dropdown.
 */
const LABEL_COLOR = 'fbca04';

/** Fixed prefix for every label this system creates. */
const LABEL_PREFIX = 'run-script:';

export type OpsScriptPhase = 'pre-deploy' | 'post-deploy';

export interface OpsScript {
  name: string;
  file: string;
  phase: OpsScriptPhase;
  description: string;
  requires_secrets: readonly string[];
  /**
   * True for a script whose only safe trigger is the manual dispatch workflow.
   * No `run-script:` label is minted for it, and the pull-request resolver in
   * `ops/lib/resolve-pr-scripts.ts` refuses one applied by hand, so the deploy
   * phases can never carry it. Absent means false: an entry earns the flag when
   * the phase a label would bind it to is the wrong moment to run it, not
   * merely when the script is dangerous.
   */
  dispatch_only?: boolean;
}

export interface OpsManifest {
  scripts: readonly OpsScript[];
}

interface GitHubLabel {
  name: string;
  description: string;
  color: string;
}

/**
 * Convert a parsed manifest into the label-sync input shape. Description
 * uses only the first line of the script's manifest description (manifest
 * descriptions are multi-line for readability; GitHub labels are single-line)
 * and truncates to the GitHub cap.
 *
 * A `dispatch_only` entry yields no label, so it never autocompletes in the
 * PR labels dropdown. The manual dispatch dropdown is generated separately
 * (`ops/lib/generate-dispatch-options.ts`) and lists every entry, flagged or
 * not — dropping the label must not drop the safe path.
 */
export function manifestToLabels(manifest: OpsManifest): GitHubLabel[] {
  return manifest.scripts
    .filter((script) => script.dispatch_only !== true)
    .map((script) => ({
      name: `${LABEL_PREFIX}${script.name}`,
      description: truncateToLabelCap(firstLine(script.description)),
      color: LABEL_COLOR,
    }));
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

function truncateToLabelCap(text: string): string {
  return text.length <= GITHUB_LABEL_DESCRIPTION_MAX
    ? text
    : text.slice(0, GITHUB_LABEL_DESCRIPTION_MAX);
}

/**
 * Read and parse `ops/manifest.yml` from a given root directory.
 * Exposed for testability and for the CLI entry point below.
 */
export function loadManifest(rootDir: string): OpsManifest {
  const manifestPath = path.resolve(rootDir, 'ops/manifest.yml');
  const raw = readFileSync(manifestPath, 'utf8');
  const parsed = yaml.load(raw);
  if (!isOpsManifest(parsed)) {
    throw new Error(`ops/manifest.yml is malformed: expected { scripts: [...] }`);
  }
  return parsed;
}

function isOpsManifest(value: unknown): value is OpsManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { scripts?: unknown };
  if (!Array.isArray(candidate.scripts)) return false;
  return candidate.scripts.every((script) => isOpsScript(script));
}

/**
 * Every key an entry may carry. The `satisfies` makes the compiler reject a
 * list that misses a field of {@link OpsScript} or names one it does not
 * declare, so the strictness below cannot drift from the interface.
 */
const OPS_SCRIPT_KEYS: ReadonlySet<string> = new Set(
  Object.keys({
    name: null,
    file: null,
    phase: null,
    description: null,
    requires_secrets: null,
    dispatch_only: null,
  } satisfies Record<keyof OpsScript, null>)
);

/**
 * An entry carrying a key outside {@link OPS_SCRIPT_KEYS} is malformed rather
 * than ignored: a near-miss spelling of `dispatch_only` otherwise parses with
 * the flag `undefined`, and the label the flag exists to suppress is minted
 * with nothing anywhere detecting it.
 */
function hasOnlyKnownKeys(value: object): boolean {
  return Object.keys(value).every((key) => OPS_SCRIPT_KEYS.has(key));
}

function isOpsScript(value: unknown): value is OpsScript {
  if (typeof value !== 'object' || value === null) return false;
  if (!hasOnlyKnownKeys(value)) return false;
  const candidate = value as Partial<Record<keyof OpsScript, unknown>>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.file === 'string' &&
    (candidate.phase === 'pre-deploy' || candidate.phase === 'post-deploy') &&
    typeof candidate.description === 'string' &&
    isSecretNameList(candidate.requires_secrets) &&
    isOptionalBoolean(candidate.dispatch_only)
  );
}

function isSecretNameList(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

/* v8 ignore start -- CLI entry: real fs reads, exits process */
function main(): void {
  const manifest = loadManifest(process.cwd());
  const labels = manifestToLabels(manifest);
  process.stdout.write(`${JSON.stringify(labels, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  main();
}
/* v8 ignore stop */
