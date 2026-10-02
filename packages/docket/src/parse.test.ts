import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEDICATED_MARKER, parseAudit, parseFinding, splitFrontmatter } from './parse.ts';
import { validateFinding } from './validate.ts';
import { HOUR_MS, MINUTE_MS } from './durations.ts';
import type { Finding, FindingIssueCode } from './types.ts';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'test-fixtures');

function fixture(name: string): { text: string; filePath: string } {
  const filePath = path.join(FIXTURE_DIR, `${name}.md`);
  return { text: readFileSync(filePath, 'utf8'), filePath };
}

function parseFixture(name: string): Finding {
  const { text, filePath } = fixture(name);
  const result = parseFinding(text, filePath);
  if (!result.ok) throw new Error(`fixture ${name} failed to parse: ${JSON.stringify(result)}`);
  return result.value;
}

function codesOf(
  text: string,
  filePath = '/audits/2026-07-30/findings/AI-1.md'
): FindingIssueCode[] {
  return parseFinding(text, filePath).issues.map((issue) => issue.code);
}

const MINIMAL = [
  '---',
  'id: "AI-1"',
  'title: "A title"',
  'severity: "critical"',
  'kind: "defect"',
  'status: "live"',
  'status_note: null',
  'area: "apps/api"',
  'needs_ruling: true',
  'needs_options: true',
  'warning: false',
  'related: []',
  'group: null',
  'dedicated: false',
  'state: "open"',
  'ruling: null',
  'denial: null',
  'history: []',
  'questions: []',
  'progress:',
  '  status: "not-started"',
  '  updated: null',
  '  verified: false',
  '  notes: []',
  '---',
  '',
  'Body.',
  '',
].join('\n');

function withLine(replacement: string, matcher: RegExp): string {
  return MINIMAL.replace(matcher, replacement);
}

describe('splitFrontmatter', () => {
  it('returns the yaml block and every byte after the closing delimiter', () => {
    const split = splitFrontmatter('---\nid: "A"\n---\n\nBody text.\n');
    expect(split).toEqual({ yaml: 'id: "A"\n', body: '\nBody text.\n' });
  });

  it('returns null when the text does not open with a delimiter', () => {
    expect(splitFrontmatter('No frontmatter here.\n')).toBeNull();
  });

  it('returns null when the frontmatter is never closed', () => {
    expect(splitFrontmatter('---\nid: "A"\n')).toBeNull();
  });
});

describe('parseFinding, frontmatter', () => {
  it('reads every scalar field with its declared type', () => {
    const finding = parseFixture('open-two-options');
    expect(finding.id).toBe('AI-1');
    expect(finding.title).toBe(
      'The database connection is torn down while post-response work is still using it'
    );
    expect(finding.severity).toBe('critical');
    expect(finding.kind).toBe('defect');
    expect(finding.status).toBe('live');
    expect(finding.status_note).toBeNull();
    expect(finding.area).toBe('apps/api');
    expect(finding.needs_ruling).toBe(true);
    expect(finding.needs_options).toBe(false);
    expect(finding.warning).toBe(true);
    expect(finding.related).toEqual(['AI-5', 'AI-9']);
    expect(finding.group).toBe('connection-lifecycle');
    expect(finding.dedicated).toBe(false);
    expect(finding.state).toBe('open');
    expect(finding.ruling).toBeNull();
    expect(finding.denial).toBeNull();
    expect(finding.history).toEqual([]);
    expect(finding.questions).toEqual([]);
    expect(finding.progress).toEqual({
      status: 'not-started',
      updated: null,
      verified: false,
      notes: [],
    });
  });

  it('reads a dedicated finding as dedicated', () => {
    expect(parseFixture('dedicated').dedicated).toBe(true);
  });

  it('reads a ruling block map', () => {
    const finding = parseFixture('ruled-history');
    expect(finding.ruling).toEqual({
      option: 'B',
      text: 'Charge the estimate and flag it, but raise one Sentry event so a human resolves it. “Estimated” must never be silent.',
      note: 'Keep fee application at the port seam.',
      at: '2026-07-30',
    });
  });

  it('reads a denial block map', () => {
    const finding = parseFixture('denied');
    expect(finding.denial).toEqual({
      by: 'human',
      reason:
        '`user.unlock` is already registered with a registered inverse, so neither option is worth building.',
      at: '2026-07-30',
    });
  });

  it('reads history entries of both kinds from their flow maps', () => {
    const finding = parseFixture('ruled-history');
    expect(finding.history).toEqual([
      {
        at: '2026-07-29',
        kind: 'ruling',
        superseded_at: '2026-07-30',
        option: 'A',
        text: null,
        note: null,
      },
      {
        at: '2026-07-28',
        kind: 'denial',
        superseded_at: '2026-07-29',
        reason: 'Refuted at triage: the gateway always returns a cost.',
        by: 'audit',
      },
    ]);
  });

  // Asked and answered on different days, so a fixture whose two keys are
  // swapped fails here rather than reading as the same question.
  it('reads an answered question, keeping the day it was asked apart from the day it was answered', () => {
    const finding = parseFixture('ruled-history');
    expect(finding.questions).toEqual([
      {
        at: '2026-07-28',
        text: 'Does the images API ever return an inline cost?',
        answer: 'No. It is charged at the deterministic catalog estimate.',
        answered_at: '2026-07-29',
      },
    ]);
  });

  it('reads an unanswered question off a finding that is otherwise open', () => {
    const finding = parseFixture('question-open');
    expect(finding.state).toBe('open');
    expect(finding.questions).toEqual([
      {
        at: '2026-07-30',
        text: 'Is a one-pass delay on an already-dead row worth changing the claim order for?',
        answer: null,
        answered_at: null,
      },
    ]);
  });

  it('reads progress notes carrying escaped newlines and unicode', () => {
    const finding = parseFixture('ruled-history');
    expect(finding.progress.status).toBe('in-progress');
    expect(finding.progress.updated).toBe('2026-07-30');
    expect(finding.progress.notes[0]?.text).toBe(
      'Reproduced with a zero-cost response.\nThe estimate path is reached, the flag is not set.'
    );
    expect(finding.progress.notes[1]?.text).toBe(
      'Ship the flag first. 日本語, “curly quotes” and a tab\tall survive.'
    );
  });

  it('reads a title carrying escaped double quotes', () => {
    const finding = parseFixture('ruled-history');
    expect(finding.title).toBe(
      'Settlement charges the estimate when the provider returns "usage.cost": 0'
    );
  });
});

describe('parseFinding, body and options', () => {
  it('keeps every byte after the closing delimiter as the body', () => {
    const { text, filePath } = fixture('open-two-options');
    const result = parseFinding(text, filePath);
    if (!result.ok) throw new Error('expected a parse');
    expect(text.endsWith(result.value.body)).toBe(true);
    expect(result.value.body.startsWith('\n**What this is.**')).toBe(true);
  });

  it('takes the text before the options heading as the explainer', () => {
    const finding = parseFixture('open-two-options');
    expect(finding.explainer).toContain('**Current behavior.**');
    expect(finding.explainer).not.toContain('## Options');
    expect(finding.explainer).not.toContain('Pipeline owns');
  });

  it('parses each option id, label, meta line and prose', () => {
    const finding = parseFixture('open-two-options');
    expect(finding.options).toEqual([
      {
        id: 'A',
        label: 'Pipeline owns post-response scheduling',
        recommended: true,
        dedicated: false,
        meta: '**Recommended** · effort: medium · risk: architectural seam',
        body: 'Move scheduling into the pipeline so the connection outlives the deferred work.',
      },
      {
        id: 'B',
        label: 'Copy the connection into the deferred closure',
        recommended: false,
        dedicated: false,
        meta: 'effort: low · risk: leaves the ownership question open',
        body: 'Cheaper, but the lifetime question returns the next time something defers.',
      },
    ]);
  });

  it('parses a prettier-formatted file to the same options as a hand-written one', () => {
    expect(parseFixture('open-two-options-prettier').options).toEqual(
      parseFixture('open-two-options').options
    );
  });

  it('yields no options and a whole-body explainer when there is no options heading', () => {
    const finding = parseFixture('no-options');
    expect(finding.options).toEqual([]);
    expect(finding.explainer).toBe(finding.body.trim());
  });

  it('takes the last options heading when the explainer mentions an earlier one', () => {
    const text = MINIMAL.replace(
      'Body.',
      [
        '## Options',
        '',
        'Not the real set.',
        '',
        '## Options',
        '',
        '### A — Real',
        '',
        'Prose.',
      ].join('\n')
    );
    const result = parseFinding(text, '/x/AI-1.md');
    if (!result.ok) throw new Error('expected a parse');
    expect(result.value.options.map((option) => option.id)).toEqual(['A']);
    expect(result.value.explainer).toContain('Not the real set.');
  });

  it('treats an option whose first content line is prose as having no meta line', () => {
    const text = MINIMAL.replace(
      'Body.',
      ['## Options', '', '### A — Label', 'Prose that runs', 'across two lines.'].join('\n')
    );
    const result = parseFinding(text, '/x/AI-1.md');
    if (!result.ok) throw new Error('expected a parse');
    expect(result.value.options[0]).toEqual({
      id: 'A',
      label: 'Label',
      recommended: false,
      dedicated: false,
      meta: null,
      body: 'Prose that runs\nacross two lines.',
    });
  });

  it('takes the whole heading as the id when it carries no label separator', () => {
    const text = MINIMAL.replace('Body.', ['## Options', '', '### A', '', 'Prose.'].join('\n'));
    const result = parseFinding(text, '/x/AI-1.md');
    if (!result.ok) throw new Error('expected a parse');
    expect(result.value.options[0]?.id).toBe('A');
    expect(result.value.options[0]?.label).toBe('');
  });

  it('yields an empty option when the heading is followed by nothing', () => {
    const text = MINIMAL.replace('Body.', ['## Options', '', '### A — Label', ''].join('\n'));
    const result = parseFinding(text, '/x/AI-1.md');
    if (!result.ok) throw new Error('expected a parse');
    expect(result.value.options).toEqual([
      { id: 'A', label: 'Label', recommended: false, dedicated: false, meta: null, body: '' },
    ]);
  });

  it('yields no options when the options heading has no option under it', () => {
    const text = MINIMAL.replace('Body.', ['## Options', '', 'Nothing here yet.'].join('\n'));
    const result = parseFinding(text, '/x/AI-1.md');
    if (!result.ok) throw new Error('expected a parse');
    expect(result.value.options).toEqual([]);
  });

  it('marks an option dedicated from the marker on its meta line', () => {
    const options = parseFixture('dedicated-option').options;
    expect(options[0]?.dedicated).toBe(true);
    expect(options[1]?.dedicated).toBe(false);
  });

  it('carries both markers on one option', () => {
    const first = parseFixture('dedicated-option').options[0];
    expect(first?.recommended).toBe(true);
    expect(first?.dedicated).toBe(true);
  });

  it('marks an option dedicated across a blank line between heading and meta line', () => {
    const text = MINIMAL.replace(
      'Body.',
      ['## Options', '', '### A — Label', '', `${DEDICATED_MARKER} · effort: large`, ''].join('\n')
    );
    const result = parseFinding(text, '/x/AI-1.md');
    if (!result.ok) throw new Error('expected a parse');
    expect(result.value.options[0]?.dedicated).toBe(true);
  });

  it('marks an option recommended from its first content line when it has no meta line', () => {
    const text = MINIMAL.replace(
      'Body.',
      [
        '## Options',
        '',
        '### A — Label',
        '**Recommended** and then more',
        'on a second line.',
      ].join('\n')
    );
    const result = parseFinding(text, '/x/AI-1.md');
    if (!result.ok) throw new Error('expected a parse');
    expect(result.value.options[0]?.recommended).toBe(true);
  });
});

describe('parseFinding, unreadable input', () => {
  it('reports missing frontmatter', () => {
    expect(codesOf('Just a body.\n')).toEqual(['missing-frontmatter']);
  });

  it('reports frontmatter that is never closed', () => {
    expect(codesOf('---\nid: "AI-1"\n')).toEqual(['unterminated-frontmatter']);
  });

  it('reports a scalar outside the quoted-string subset', () => {
    expect(codesOf(withLine('state: open', /state: "open"/))).toEqual(['malformed-yaml']);
  });

  it('reports a line that is not a key-value pair', () => {
    expect(codesOf(MINIMAL.replace('group: null', 'just-a-word'))).toEqual(['malformed-yaml']);
  });

  it('reports a sequence item under a scalar key', () => {
    expect(codesOf(MINIMAL.replace('group: null', 'group: "g"\n  - "stray"'))).toEqual([
      'malformed-yaml',
    ]);
  });

  it('reports a flow map that is never closed', () => {
    expect(codesOf(MINIMAL.replace('related: []', 'related:\n  - { at: "x"'))).toEqual([
      'malformed-yaml',
    ]);
  });

  it('reports a missing required field', () => {
    expect(codesOf(MINIMAL.replace('area: "apps/api"\n', ''))).toEqual(['missing-field']);
  });

  it('reports a field holding the wrong scalar type', () => {
    expect(codesOf(withLine('warning: "false"', /warning: false/))).toEqual(['invalid-type']);
  });

  it('reports an unknown enum value', () => {
    expect(codesOf(withLine('severity: "urgent"', /severity: "critical"/))).toEqual([
      'invalid-enum',
    ]);
  });

  it('reports an unknown enum value nested in a map', () => {
    expect(codesOf(MINIMAL.replace('  status: "not-started"', '  status: "pending"'))).toEqual([
      'invalid-enum',
    ]);
  });

  it('reports an unknown enum value nested in a flow map', () => {
    expect(
      codesOf(
        MINIMAL.replace('  notes: []', '  notes:\n    - { at: "x", by: "sideways", text: "t" }')
      )
    ).toEqual(['invalid-enum']);
  });

  it('reports a state the format no longer has', () => {
    expect(codesOf(MINIMAL.replace('state: "open"', 'state: "question"'))).toEqual([
      'invalid-enum',
    ]);
  });

  it('reports an unknown history kind', () => {
    expect(
      codesOf(
        MINIMAL.replace(
          'history: []',
          'history:\n  - { at: "x", kind: "note", superseded_at: "y", option: "A", text: null, note: null }'
        )
      )
    ).toEqual(['invalid-enum']);
  });

  it('reports a related list holding a non-string', () => {
    expect(codesOf(MINIMAL.replace('related: []', 'related:\n  - 7'))).toEqual(['invalid-type']);
  });

  it('reports a map field given a scalar', () => {
    expect(codesOf(withLine('ruling: "A"', /ruling: null/))).toEqual(['invalid-type']);
  });

  it('reports a list field given a scalar', () => {
    expect(codesOf(withLine('history: 3', /history: \[\]/))).toEqual(['invalid-type']);
  });

  it('collects every field problem in one pass rather than stopping at the first', () => {
    const broken = MINIMAL.replace('severity: "critical"', 'severity: "urgent"').replace(
      'kind: "defect"',
      'kind: "opinion"'
    );
    expect(codesOf(broken)).toEqual(['invalid-enum', 'invalid-enum']);
  });

  it('reports a quoted string that is never terminated', () => {
    expect(codesOf(withLine('title: "unterminated', /title: "A title"/))).toEqual([
      'malformed-yaml',
    ]);
  });

  it('reports a flow map nested inside a flow map', () => {
    expect(
      codesOf(MINIMAL.replace('history: []', 'history:\n  - { at: "x", kind: { deep: "no" } }'))
    ).toEqual(['malformed-yaml']);
  });

  it('reports a nested flow map carrying its own separators', () => {
    expect(
      codesOf(
        MINIMAL.replace('history: []', 'history:\n  - { at: { early: "x", late: "y" }, kind: "n" }')
      )
    ).toEqual(['malformed-yaml']);
  });

  it('reports a progress field given a scalar', () => {
    const withoutProgress = MINIMAL.replace(
      'progress:\n  status: "not-started"\n  updated: null\n  verified: false\n  notes: []\n',
      'progress: "done"\n'
    );
    expect(codesOf(withoutProgress)).toEqual(['invalid-type']);
  });

  it('reports text trailing a closed flow map', () => {
    expect(codesOf(MINIMAL.replace('history: []', 'history:\n  - { at: "x" } and more'))).toEqual([
      'malformed-yaml',
    ]);
  });

  it('reports a flow-map entry that is not a key-value pair', () => {
    expect(codesOf(MINIMAL.replace('history: []', 'history:\n  - { garbage }'))).toEqual([
      'malformed-yaml',
    ]);
  });

  it('reports a key given neither a value nor children', () => {
    expect(codesOf(MINIMAL.replace('related: []', 'related:'))).toEqual(['malformed-yaml']);
  });

  it('reads an empty flow map, leaving its fields missing', () => {
    const codes = codesOf(MINIMAL.replace('history: []', 'history:\n  - {}'));
    expect(codes.length).toBeGreaterThan(0);
    expect(new Set(codes)).toEqual(new Set(['missing-field']));
  });

  it('reports a history list holding a non-map', () => {
    expect(codesOf(MINIMAL.replace('history: []', 'history:\n  - "AI-2"'))).toEqual([
      'invalid-type',
    ]);
  });

  it('reports a string field given an integer', () => {
    expect(codesOf(withLine('id: 7', /id: "AI-1"/))).toEqual(['invalid-type']);
  });

  it('reports a nullable-string field given a boolean', () => {
    expect(codesOf(withLine('status_note: true', /status_note: null/))).toEqual(['invalid-type']);
  });

  it('reports an enum field given an integer', () => {
    expect(codesOf(withLine('severity: 3', /severity: "critical"/))).toEqual(['invalid-type']);
  });

  it.each([
    ['a nullable string', 'status_note: null\n'],
    ['a boolean', 'warning: false\n'],
    ['an enum', 'severity: "critical"\n'],
    ['a nullable map', 'ruling: null\n'],
    ['a list', 'related: []\n'],
  ])('reports %s field that is absent entirely', (_label, line) => {
    expect(codesOf(MINIMAL.replace(line, ''))).toEqual(['missing-field']);
  });

  it('reports an absent dedicated key, the field being required like every other', () => {
    expect(codesOf(MINIMAL.replace('dedicated: false\n', ''))).toEqual(['missing-field']);
  });

  it('reports an absent progress map', () => {
    const withoutProgress = MINIMAL.replace(
      'progress:\n  status: "not-started"\n  updated: null\n  verified: false\n  notes: []\n',
      ''
    );
    expect(codesOf(withoutProgress)).toEqual(['missing-field']);
  });

  it('names the offending field on the issue', () => {
    const result = parseFinding(
      withLine('severity: "urgent"', /severity: "critical"/),
      '/x/AI-1.md'
    );
    expect(result.issues[0]?.field).toBe('severity');
  });
});

describe('parseFinding, structural invariants', () => {
  it('parses the finding and reports the mismatch when the id is not the filename stem', () => {
    const { text } = fixture('open-two-options');
    const result = parseFinding(text, '/audits/2026-07-30/findings/AI-2.md');
    expect(result.ok).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toEqual(['id-filename-mismatch']);
  });

  it('accepts an id that is already the filename stem', () => {
    const { text, filePath } = fixture('open-two-options');
    expect(parseFinding(text, filePath.replace('open-two-options', 'AI-1')).issues).toEqual([]);
  });

  it('surfaces a structural invariant break alongside a successful parse', () => {
    const text = MINIMAL.replace(
      'ruling: null',
      'ruling:\n  option: "A"\n  text: null\n  note: null\n  at: "2026-07-30"'
    );
    const result = parseFinding(text, '/x/AI-1.md');
    expect(result.ok).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toEqual(['ruling-without-ruled-state']);
  });

  it('accepts a finding the audit denied at emission, the shape a refuted item ships in', () => {
    const { text, filePath } = fixture('denied-at-emission');
    const result = parseFinding(text, filePath.replace('denied-at-emission', 'CLEAN-1'));
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    if (!result.ok) return;
    expect(validateFinding(result.value, 'emission')).toEqual([]);
  });

  it('does not report an emission-rule break on parse', () => {
    const { text } = fixture('denied');
    const result = parseFinding(text, '/audits/2026-07-30/findings/SEC-LOCK.md');
    expect(result.issues).toEqual([]);
  });
});

describe('parseAudit', () => {
  it('reads the header fields and keeps the body', () => {
    const text = [
      '---',
      'layout_version: 1',
      'date: "2026-07-30"',
      'title: "Full-repo quality audit"',
      'scope: "What this run covered."',
      'status: "open"',
      '---',
      '',
      '**What this run covered.** Everything.',
      '',
    ].join('\n');
    const result = parseAudit(text);
    if (!result.ok) throw new Error('expected a parse');
    expect(result.value).toEqual({
      layout_version: 1,
      date: '2026-07-30',
      title: 'Full-repo quality audit',
      scope: 'What this run covered.',
      body: '\n**What this run covered.** Everything.\n',
    });
  });

  it('reports missing frontmatter', () => {
    const result = parseAudit('No header.\n');
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['missing-frontmatter']);
  });

  it('reports a non-integer layout_version', () => {
    const text = [
      '---',
      'layout_version: "1"',
      'date: "2026-07-30"',
      'title: "T"',
      'scope: "S"',
      'status: "open"',
      '---',
      '',
    ].join('\n');
    expect(parseAudit(text).issues.map((issue) => issue.code)).toEqual(['invalid-type']);
  });

  it('reports an absent layout_version', () => {
    const text = [
      '---',
      'date: "2026-07-30"',
      'title: "T"',
      'scope: "S"',
      'status: "open"',
      '---',
      '',
    ].join('\n');
    expect(parseAudit(text).issues.map((issue) => issue.code)).toEqual(['missing-field']);
  });

  it('reads a header carrying no status at all', () => {
    const text = [
      '---',
      'layout_version: 2',
      'date: "2026-07-30"',
      'title: "T"',
      'scope: "S"',
      '---',
      '',
    ].join('\n');
    const result = parseAudit(text);
    if (!result.ok) throw new Error('expected a parse');
    expect(result.issues).toEqual([]);
    expect(result.value).toEqual({
      layout_version: 2,
      date: '2026-07-30',
      title: 'T',
      scope: 'S',
      body: '',
    });
  });

  // The one full instant the corpus still holds, and what proves the header is
  // covered by the day rule rather than exempted from it. A day plus an offset
  // because the repository's own privacy gate refuses a written-out clock.
  it('refuses a header dated with an instant', () => {
    const text = [
      '---',
      'layout_version: 1',
      `date: "${new Date(Date.UTC(2026, 6, 30) + 14 * HOUR_MS + 12 * MINUTE_MS).toISOString()}"`,
      'title: "T"',
      'scope: "S"',
      '---',
      '',
    ].join('\n');
    const result = parseAudit(text);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['non-day-timestamp']);
  });

  it('ignores a key the header no longer carries rather than refusing the file', () => {
    const text = [
      '---',
      'layout_version: 1',
      'date: "2026-07-30"',
      'title: "T"',
      'scope: "S"',
      'status: "open"',
      '---',
      '',
    ].join('\n');
    const result = parseAudit(text);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.ok && 'status' in result.value).toBe(false);
  });
});

describe('parseFinding, template skeleton', () => {
  it('parses the audit skill finding skeleton clean', () => {
    const templatePath = path.join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '.claude',
      'skills',
      'improve-codebase',
      'template',
      'finding.md'
    );
    const result = parseFinding(readFileSync(templatePath, 'utf8'), '/x/AREA-1.md');
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    if (!result.ok) return;
    expect(result.value.options.map((option) => option.id)).toEqual(['A', 'B']);
    expect(result.value.options[0]?.recommended).toBe(true);
  });

  it('parses the audit skill audit skeleton clean', () => {
    const templatePath = path.join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '.claude',
      'skills',
      'improve-codebase',
      'template',
      'audit.md'
    );
    const result = parseAudit(readFileSync(templatePath, 'utf8'));
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });
});
