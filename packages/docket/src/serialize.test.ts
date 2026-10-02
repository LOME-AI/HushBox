import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseFinding, splitFrontmatter } from './parse.ts';
import { FRONTMATTER_KEY_ORDER } from './frontmatter-order.ts';
import { serializeFinding } from './serialize.ts';
import type { Finding } from './types.ts';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'test-fixtures');

const FIXTURES = [
  'open-two-options',
  'open-two-options-prettier',
  'ruled-history',
  'question-open',
  'denied',
  'denied-at-emission',
  'no-options',
  'dedicated',
  'dedicated-option',
] as const;

function load(name: string): { text: string; finding: Finding } {
  const filePath = path.join(FIXTURE_DIR, `${name}.md`);
  const text = readFileSync(filePath, 'utf8');
  const result = parseFinding(text, filePath);
  if (!result.ok) throw new Error(`fixture ${name} failed to parse: ${JSON.stringify(result)}`);
  return { text, finding: result.value };
}

function bodyOf(text: string): string {
  const split = splitFrontmatter(text);
  if (split === null) throw new Error('expected frontmatter');
  return split.body;
}

function topLevelKeys(text: string): string[] {
  const split = splitFrontmatter(text);
  if (split === null) throw new Error('expected frontmatter');
  return split.yaml
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith(' '))
    .map((line) => line.slice(0, line.indexOf(':')));
}

describe('serializeFinding, round trip', () => {
  it.each(FIXTURES)('re-emits %s byte for byte when nothing changed', (name) => {
    const { text, finding } = load(name);
    expect(serializeFinding(finding, text)).toBe(text);
  });

  it.each(FIXTURES)('parses back to the same finding after a serialize of %s', (name) => {
    const { text, finding } = load(name);
    const reparsed = parseFinding(
      serializeFinding(finding, text),
      path.join(FIXTURE_DIR, `${finding.id}.md`)
    );
    if (!reparsed.ok) throw new Error(`re-parse failed: ${JSON.stringify(reparsed)}`);
    expect(reparsed.value).toEqual(finding);
  });
});

describe('serializeFinding, body preservation', () => {
  it('leaves the body bytes untouched when the frontmatter changes', () => {
    const { text, finding } = load('open-two-options');
    const ruled: Finding = {
      ...finding,
      state: 'ruled',
      ruling: { option: 'A', text: 'Do it.', note: null, at: '2026-07-30' },
      progress: {
        status: 'in-progress',
        updated: '2026-07-30',
        verified: false,
        notes: [{ at: '2026-07-30', by: 'agent', text: 'Started.' }],
      },
    };
    const written = serializeFinding(ruled, text);
    expect(written).not.toBe(text);
    expect(bodyOf(written)).toBe(bodyOf(text));
  });

  it('takes the body from the original text, never from the finding', () => {
    const { text, finding } = load('open-two-options');
    const tampered: Finding = { ...finding, body: '\nRewritten body.\n' };
    expect(bodyOf(serializeFinding(tampered, text))).toBe(bodyOf(text));
  });

  it('treats text carrying no frontmatter as a body, so a new finding can be written', () => {
    const { finding } = load('open-two-options');
    const written = serializeFinding(finding, '\nA brand new body.\n');
    expect(bodyOf(written)).toBe('\nA brand new body.\n');
    expect(written.startsWith('---\nid: "AI-1"\n')).toBe(true);
  });
});

describe('serializeFinding, emission', () => {
  it('emits the top-level keys in the fixed order', () => {
    const { text, finding } = load('ruled-history');
    expect(topLevelKeys(serializeFinding(finding, text))).toEqual([...FRONTMATTER_KEY_ORDER]);
  });

  it('emits the same key order regardless of how the input was ordered', () => {
    const { text, finding } = load('no-options');
    expect(topLevelKeys(serializeFinding(finding, text))).toEqual([...FRONTMATTER_KEY_ORDER]);
  });

  it('takes its key order from the declared constant rather than a second copy of it', async () => {
    const reversed = [...FRONTMATTER_KEY_ORDER].toReversed();
    vi.resetModules();
    vi.doMock('./frontmatter-order.js', () => ({ FRONTMATTER_KEY_ORDER: reversed }));
    try {
      const { serializeFinding: reordering } = await import('./serialize.ts');
      const { text, finding } = load('ruled-history');
      expect(topLevelKeys(reordering(finding, text))).toEqual(reversed);
    } finally {
      vi.doUnmock('./frontmatter-order.js');
      vi.resetModules();
    }
  });

  it('emits an empty list inline and a populated one as a block sequence', () => {
    const { text, finding } = load('open-two-options');
    const written = serializeFinding(finding, text);
    expect(written).toContain('history: []\n');
    expect(written).toContain('related:\n  - "AI-5"\n  - "AI-9"\n');
  });

  it('quotes every string, including enum values', () => {
    const { text, finding } = load('open-two-options');
    const written = serializeFinding(finding, text);
    expect(written).toContain('state: "open"\n');
    expect(written).toContain('severity: "critical"\n');
    expect(written).toContain('  status: "not-started"\n');
  });

  it('emits booleans, nulls and integers unquoted', () => {
    const { text, finding } = load('open-two-options');
    const written = serializeFinding(finding, text);
    expect(written).toContain('needs_ruling: true\n');
    expect(written).toContain('group: "connection-lifecycle"\n');
    expect(written).toContain('ruling: null\n');
  });

  it('json-escapes quotes, newlines and tabs inside a string', () => {
    const { text, finding } = load('open-two-options');
    const written = serializeFinding(
      { ...finding, status_note: 'a "quote", a\nnewline and a\ttab' },
      text
    );
    expect(written).toContain('status_note: "a \\"quote\\", a\\nnewline and a\\ttab"\n');
  });

  it.each([
    ['a line separator', ' '],
    ['a paragraph separator', ' '],
  ])('escapes %s so one key stays one physical line', (_label, character) => {
    const { text, finding } = load('open-two-options');
    const note = `before${character}after`;
    const written = serializeFinding({ ...finding, status_note: note }, text);

    expect(written).not.toContain(character);
    expect(written.split('\n').filter((line) => line.startsWith('status_note:'))).toHaveLength(1);

    const reparsed = parseFinding(written, path.join(FIXTURE_DIR, `${finding.id}.md`));
    if (!reparsed.ok) throw new Error(`re-parse failed: ${JSON.stringify(reparsed)}`);
    expect(reparsed.value.status_note).toBe(note);
  });

  it.each([
    ['a line separator', ' '],
    ['a paragraph separator', ' '],
  ])('escapes %s inside a flow map too', (_label, character) => {
    const { text, finding } = load('open-two-options');
    const note = `before${character}after`;
    const written = serializeFinding(
      {
        ...finding,
        progress: {
          ...finding.progress,
          notes: [{ at: '2026-07-30', by: 'agent', text: note }],
        },
      },
      text
    );

    expect(written).not.toContain(character);

    const reparsed = parseFinding(written, path.join(FIXTURE_DIR, `${finding.id}.md`));
    if (!reparsed.ok) throw new Error(`re-parse failed: ${JSON.stringify(reparsed)}`);
    expect(reparsed.value.progress.notes[0]?.text).toBe(note);
  });

  it('emits a list of maps as inline flow maps', () => {
    const { text, finding } = load('question-open');
    expect(serializeFinding(finding, text)).toContain(
      'questions:\n  - { at: "2026-07-30", text: "Is a one-pass delay on an already-dead row worth changing the claim order for?", answer: null, answered_at: null }\n'
    );
  });

  it('emits a ruling history entry without the denial keys', () => {
    const { text, finding } = load('ruled-history');
    const written = serializeFinding(finding, text);
    expect(written).toContain(
      '  - { at: "2026-07-29", kind: "ruling", superseded_at: "2026-07-30", option: "A", text: null, note: null }\n'
    );
  });

  it('emits a denial history entry without the ruling keys', () => {
    const { text, finding } = load('ruled-history');
    expect(serializeFinding(finding, text)).toContain(
      ', kind: "denial", superseded_at: "2026-07-29", reason: "Refuted at triage: the gateway always returns a cost.", by: "audit" }\n'
    );
  });

  it('nests progress notes under progress as a block sequence', () => {
    const { text, finding } = load('no-options');
    expect(serializeFinding(finding, text)).toContain(
      'progress:\n  status: "not-started"\n  updated: "2026-07-30"\n  verified: false\n  notes:\n    - { at:'
    );
  });
});
