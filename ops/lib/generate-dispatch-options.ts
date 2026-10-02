#!/usr/bin/env tsx
/**
 * Generate the `workflow_dispatch` choice options for the manual ops runner
 * (`.github/workflows/run-ops-script.yml`) from `ops/manifest.yml`.
 *
 * GitHub renders `workflow_dispatch` `choice` inputs from the *committed*
 * workflow YAML — there is no way to populate options dynamically at dispatch
 * time. So the dropdown is generated here, and CI re-runs this generator and
 * diffs the workflow (`git diff --exit-code`), which fails the build when the
 * marked section no longer matches the manifest. An option added outside the
 * markers is not in that comparison. Add a script to the manifest, regenerate,
 * commit — and it appears in the dropdown.
 *
 * Standalone CLI: `pnpm tsx ops/lib/generate-dispatch-options.ts` (rewrites the
 * marked section in place).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadManifest, type OpsManifest } from './generate-labels.js';

/**
 * Marker the generated option list is written between, in the workflow YAML.
 * Exported so the marker assertions can reach this generator's pair: it is not
 * in the env generator's section map.
 */
export const DISPATCH_OPTIONS_MARKER = 'ops-dispatch-options';

/** Workflow file whose dropdown this generator owns. */
export const DISPATCH_WORKFLOW_PATH = '.github/workflows/run-ops-script.yml';

/**
 * Where a section renders: one entry per marker pair, the shape the env
 * generator's ownership uses, so both generators' sections are measurable the
 * same way. Non-empty by type, which is what keeps a zero-pair replacement — a
 * silent no-op over a file that has lost its markers — out of the language.
 */
type SectionOwners = readonly [typeof DISPATCH_WORKFLOW_PATH, ...(typeof DISPATCH_WORKFLOW_PATH)[]];

/** Where this generator's one section renders. */
export const DISPATCH_OPTIONS_OWNERS: SectionOwners = [DISPATCH_WORKFLOW_PATH];

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
 *
 * `owners` is the section's ownership, one entry per marker pair: a replacement
 * that finds a different number of pairs than the ownership declares would
 * write nothing, or write into a block ownership does not know about, so it
 * stops instead.
 *
 * Both markers are pinned to the end of their line. Without the END-side pin, a
 * block that lost its own END marker matches through to the END of a
 * longer-named sibling, and the replacement deletes everything between.
 */
export function replaceGeneratedSection(
  content: string,
  marker: string,
  newContent: string,
  owners: SectionOwners
): string {
  const regex = new RegExp(
    String.raw`([ ]*)# BEGIN GENERATED: ${marker}\n[\s\S]*?# END GENERATED: ${marker}(?=\r?\n|$)`,
    'g'
  );

  const found = [...content.matchAll(regex)].length;
  if (found !== owners.length) {
    throw new Error(
      `${DISPATCH_WORKFLOW_PATH}: ${marker} — ${String(owners.length)} declared, ${String(found)} found\n` +
        'Restore the missing marker pair, or update DISPATCH_OPTIONS_OWNERS in ' +
        'ops/lib/generate-dispatch-options.ts to match where it renders now.'
    );
  }

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
    manifestToDispatchOptions(manifest),
    DISPATCH_OPTIONS_OWNERS
  );
  writeFileSync(workflowPath, updated);
  console.log(`Updated ${DISPATCH_WORKFLOW_PATH} dropdown from ops/manifest.yml`);
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  updateDispatchWorkflow(process.cwd());
}
/* v8 ignore stop */
