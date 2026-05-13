#!/usr/bin/env tsx
/**
 * Generate the GitHub label config consumed by EndBug/label-sync.
 *
 * Reads `ops/manifest.yml` and emits a JSON array of
 * `{ name, description, color }` entries — one `run-script:<name>` label
 * per script in the manifest. The sync workflow
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
}

export interface OpsManifest {
  scripts: readonly OpsScript[];
}

export interface GitHubLabel {
  name: string;
  description: string;
  color: string;
}

/**
 * Convert a parsed manifest into the label-sync input shape. Description
 * uses only the first line of the script's manifest description (manifest
 * descriptions are multi-line for readability; GitHub labels are single-line)
 * and truncates to the GitHub cap.
 */
export function manifestToLabels(manifest: OpsManifest): GitHubLabel[] {
  return manifest.scripts.map((script) => ({
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

function isOpsScript(value: unknown): value is OpsScript {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof OpsScript, unknown>>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.file === 'string' &&
    (candidate.phase === 'pre-deploy' || candidate.phase === 'post-deploy') &&
    typeof candidate.description === 'string' &&
    Array.isArray(candidate.requires_secrets) &&
    candidate.requires_secrets.every((value) => typeof value === 'string')
  );
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
