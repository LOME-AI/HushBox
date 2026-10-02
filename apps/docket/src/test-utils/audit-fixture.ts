import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * A throwaway repository root holding one audit directory, used by every server
 * test so the store, the routes and the watcher all run against real files
 * rather than a mock of the format.
 */
export const FIXTURE_AUDIT_DATE = '2026-07-30';

export const FIXTURE_AUDIT_HEADER = `---
layout_version: 1
date: "${FIXTURE_AUDIT_DATE}"
title: "Codebase audit"
scope: "The whole repository."
status: "open"
---

# Codebase audit
`;

export interface FindingOverrides {
  readonly title?: string;
  readonly state?: string;
  readonly dedicated?: boolean;
  readonly body?: string;
}

export function findingFile(id: string, overrides: FindingOverrides = {}): string {
  const title = overrides.title ?? `${id} needs a decision`;
  const state = overrides.state ?? 'open';
  const dedicated = overrides.dedicated ?? false;
  const body =
    overrides.body ??
    `**What it is.** Something at \`src/inside.ts:2\`.

## Options

### A — Apply the proposed behavior as written
**Recommended**

Do the thing.
`;
  return `---
id: "${id}"
title: "${title}"
severity: "medium"
kind: "defect"
status: "live"
status_note: null
area: "unknown"
needs_ruling: true
needs_options: false
warning: false
related: []
group: null
dedicated: ${String(dedicated)}
state: "${state}"
ruling: null
denial: null
history: []
questions: []
progress:
  status: "not-started"
  updated: null
  verified: false
  notes: []
---

${body}`;
}

export interface AuditFixture {
  readonly root: string;
  readonly auditDir: string;
  readonly findingsDir: string;
  writeFinding(id: string, overrides?: FindingOverrides): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createAuditFixture(
  ids: readonly string[] = ['AC-1', 'AC-2']
): Promise<AuditFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docket-fixture-'));
  const auditDir = path.join(root, 'docs', 'audits', FIXTURE_AUDIT_DATE);
  const findingsDir = path.join(auditDir, 'findings');
  await fs.mkdir(findingsDir, { recursive: true });
  await fs.writeFile(path.join(auditDir, 'audit.md'), FIXTURE_AUDIT_HEADER);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'inside.ts'), 'one\ntwo\nthree\n');

  const fixture: AuditFixture = {
    root,
    auditDir,
    findingsDir,
    async writeFinding(id, overrides = {}) {
      await fs.writeFile(path.join(findingsDir, `${id}.md`), findingFile(id, overrides));
    },
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };

  for (const id of ids) await fixture.writeFinding(id);
  return fixture;
}
