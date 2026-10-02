// The templates an audit run copies from live under
// `.claude/skills/improve-codebase/template/`, which no lint, typecheck or test
// path in this repository reaches, and they author the two files this package
// parses. This test reaches across that boundary because nothing else does, and
// because the drift it guards is silent: the parser takes any frontmatter key
// at the block indent, so a finding authored from a stale template parses and
// validates clean, and the key the format no longer carries disappears on the
// first serializer write — on a finding a human is part-way through ruling.
// Byte-identical round-tripping is the only assertion that sees it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAudit, parseFinding } from './parse.ts';
import { serializeFinding } from './serialize.ts';
import { resolveAuditDir } from './store.ts';
import type { Finding, ParseResult } from './types.ts';

// Anchored to this file rather than to the working directory, which differs
// between a repo-root run and a package-scoped one.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const TEMPLATE_DIR = path.join(REPO_ROOT, '.claude', 'skills', 'improve-codebase', 'template');
const AUDITS_ROOT = path.join(REPO_ROOT, 'docs', 'audits');
const AUDIT_FILE = 'audit.md';

const FINDING_TEMPLATE = readFileSync(path.join(TEMPLATE_DIR, 'finding.md'), 'utf8');

/** A key the format carried and retired: the drift this file exists to catch. */
const RETIRED_KEY = 'severity_original: "high"';

/**
 * A finding file is named after its id, so the template is read under the path
 * the finding it authors would occupy. That makes the issues reported here the
 * ones `--validate` reports over a corpus written from this template.
 */
function parseAsAuthored(text: string): ParseResult<Finding> {
  const probe = parseFinding(text, path.join(TEMPLATE_DIR, 'finding.md'));
  if (!probe.ok) throw new Error(`the finding template does not parse: ${JSON.stringify(probe)}`);
  return parseFinding(text, path.join(TEMPLATE_DIR, `${probe.value.id}.md`));
}

function roundTrip(text: string): string {
  const parsed = parseAsAuthored(text);
  if (!parsed.ok) throw new Error(`the finding template does not parse: ${JSON.stringify(parsed)}`);
  return serializeFinding(parsed.value, text);
}

function withRetiredKey(text: string): string {
  const [first, ...rest] = text.split('\n');
  return [first, RETIRED_KEY, ...rest].join('\n');
}

describe('the finding template against the format it authors', () => {
  it('round-trips byte for byte through the serializer', () => {
    expect(roundTrip(FINDING_TEMPLATE)).toBe(FINDING_TEMPLATE);
  });

  it('stops round-tripping once it authors a key the format retired', () => {
    const stale = withRetiredKey(FINDING_TEMPLATE);
    const emitted = roundTrip(stale);

    expect(emitted).not.toBe(stale);
    expect(emitted).not.toContain(RETIRED_KEY);
  });

  it('reports no validation issue under that same drift', () => {
    expect(parseAsAuthored(withRetiredKey(FINDING_TEMPLATE)).issues).toStrictEqual([]);
  });
});

describe('the audit template against the format it authors', () => {
  it('declares the layout version the live corpus header carries', async () => {
    const corpus = parseAudit(
      readFileSync(path.join(await resolveAuditDir(AUDITS_ROOT), AUDIT_FILE), 'utf8')
    );
    const template = parseAudit(readFileSync(path.join(TEMPLATE_DIR, AUDIT_FILE), 'utf8'));
    if (!corpus.ok) throw new Error(`the corpus header does not parse: ${JSON.stringify(corpus)}`);
    if (!template.ok) {
      throw new Error(`the audit template does not parse: ${JSON.stringify(template)}`);
    }

    expect(template.value.layout_version).toBe(corpus.value.layout_version);
  });
});
