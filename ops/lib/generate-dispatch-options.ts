#!/usr/bin/env tsx
/**
 * Generate the `workflow_dispatch` choice options for the manual ops runner
 * (`.github/workflows/run-ops-script.yml`) from `ops/manifest.yml`.
 *
 * GitHub renders `workflow_dispatch` `choice` inputs from the *committed*
 * workflow YAML — there is no way to populate options dynamically at dispatch
 * time. So the dropdown is generated here and kept honest by a CI drift gate
 * (`pnpm generate:ops-dispatch` + `git diff --exit-code`). Add a script to the
 * manifest, regenerate, commit — and it appears in the dropdown.
 *
 * Standalone CLI: `pnpm tsx ops/lib/generate-dispatch-options.ts` (rewrites the
 * marked section in place).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadManifest, type OpsManifest } from './generate-labels.js';

/** Marker the generated option list is written between, in the workflow YAML. */
const DISPATCH_OPTIONS_MARKER = 'ops-dispatch-options';

/** Workflow file whose dropdown this generator owns. */
const DISPATCH_WORKFLOW_PATH = '.github/workflows/run-ops-script.yml';

/**
 * Render the manifest's script names as `workflow_dispatch` choice option
 * lines (one `- <name>` per script, in manifest order, trailing newline).
 * Indentation is applied by {@link replaceGeneratedSection}.
 */
export function manifestToDispatchOptions(manifest: OpsManifest): string {
  return manifest.scripts.map((script) => `- ${script.name}`).join('\n') + '\n';
}

/**
 * Replace a `# BEGIN GENERATED: <marker>` … `# END GENERATED: <marker>`
 * section, re-indenting the new body to match the BEGIN marker. Mirrors
 * `replaceSection` in `scripts/generate-env.ts` — duplicated rather than
 * imported to keep `ops/` self-contained (see `ops/lib/run-cli.ts`).
 */
export function replaceGeneratedSection(
  content: string,
  marker: string,
  newContent: string
): string {
  const regex = new RegExp(
    String.raw`([ ]*)# BEGIN GENERATED: ${marker}\n[\s\S]*?# END GENERATED: ${marker}`,
    'g'
  );

  return content.replace(regex, (_, indent: string) => {
    const indentedContent = newContent
      .split('\n')
      .map((line) => (line ? indent + line : line))
      .join('\n');
    return `${indent}# BEGIN GENERATED: ${marker}\n${indentedContent}${indent}# END GENERATED: ${marker}`;
  });
}

/* v8 ignore start -- CLI entry: real fs reads/writes, exits process */
function updateDispatchWorkflow(rootDir: string): void {
  const workflowPath = path.resolve(rootDir, DISPATCH_WORKFLOW_PATH);
  const manifest = loadManifest(rootDir);
  const content = readFileSync(workflowPath, 'utf8');
  const updated = replaceGeneratedSection(
    content,
    DISPATCH_OPTIONS_MARKER,
    manifestToDispatchOptions(manifest)
  );
  writeFileSync(workflowPath, updated);
  console.log(`Updated ${DISPATCH_WORKFLOW_PATH} dropdown from ops/manifest.yml`);
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  updateDispatchWorkflow(process.cwd());
}
/* v8 ignore stop */
