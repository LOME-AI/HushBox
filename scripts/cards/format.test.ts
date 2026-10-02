import { describe, expect, it } from 'vitest';
import { parseCard, parseStatus, serializeStatus, type StatusFile } from './format.js';

const SAMPLE = `# Status — wallet lock order

📊 after T04 audit PASS

| ✅ done | 🔧 in-flight | ⏸ blocked | ⬜ queued | ❓ open |
| --- | --- | --- | --- | --- |
| 5 | T07 | T03 → Q2 | 4 | 1 (1 blocking) |

## Open

## ✅ Q2 — should the wallet lock move before the ledger insert? [blocking T03]

**Problem** — \`settle.ts:40\` inserts the ledger legs before taking the wallet row lock.

| Option | Pros | Cons | Value |
| --- | --- | --- | --- |
| A. lock first | no deadlock | one more round trip | crash recovery |

\`\`\`mermaid
sequenceDiagram
  A->>B: lock
\`\`\`

**Recommendation** — A, for crash recovery by construction.

**Decision** — Move the wallet lock ahead of the ledger insert in \`settle.ts\`.

**Alternatives** — B. lock after — loses under contention.

**Answer:**

## 📝 Q3 — should the estimator round half-even? [blocks nothing]

**Problem** — draft.

**Recommendation** — draft.

**Decision** — draft.

**Alternatives** — draft.

## Answered

## ✅ Q1 — should the hold expire on deadline? [blocking T01]

**Problem** — the hold outlives the run.

**Recommendation** — expire it.

**Decision** — Give the hold the run deadline as its TTL.

**Alternatives** — none viable.

**Grade:** Verified by reading.

**Answer:** yes, expire it

**Work:** T01 (hold TTL) criteria amended.
`;

describe('parseStatus', () => {
  it('reads the title, the chart cells, and every card into its section', () => {
    const file = parseStatus(SAMPLE);
    expect(file.title).toBe('wallet lock order');
    expect(file.chart).toEqual({
      stamp: 'after T04 audit PASS',
      done: '5',
      inFlight: 'T07',
      blocked: 'T03 → Q2',
      queued: '4',
    });
    expect(file.open.map((card) => card.id)).toEqual([2, 3]);
    expect(file.answered.map((card) => card.id)).toEqual([1]);
  });

  it('reads a card title into state, id, question, and blocks', () => {
    const [ready, draft] = parseStatus(SAMPLE).open;
    expect(ready).toMatchObject({
      state: 'ready',
      id: 2,
      question: 'should the wallet lock move before the ledger insert?',
      blocks: ['T03'],
    });
    expect(draft).toMatchObject({ state: 'drafting', id: 3, blocks: [] });
  });

  it('keeps a field body opaque, tables and fences included', () => {
    const [ready] = parseStatus(SAMPLE).open;
    const problem = ready?.fields.find((field) => field.name === 'Problem');
    expect(problem?.text).toContain('| A. lock first |');
    expect(problem?.text).toContain('sequenceDiagram');
    expect(problem?.text.endsWith('```')).toBe(true);
  });

  it('reads an unknown field such as Grade and an inline Answer', () => {
    const [answered] = parseStatus(SAMPLE).answered;
    expect(answered?.fields.map((field) => field.name)).toEqual([
      'Problem',
      'Recommendation',
      'Decision',
      'Alternatives',
      'Grade',
      'Answer',
      'Work',
    ]);
    expect(answered?.fields.find((field) => field.name === 'Answer')?.text).toBe('yes, expire it');
  });

  it('keeps a bold-led paragraph before the first field as preamble, not a field', () => {
    const [ready] = parseStatus(
      SAMPLE.replace('**Problem** — `settle', '**wrong** lead\n\n**Problem** — `settle')
    ).open;
    expect(ready?.preamble).toBe('**wrong** lead');
    expect(ready?.fields[0]?.name).toBe('Problem');
  });

  it('keeps prose before the first field as the card preamble', () => {
    const withPreamble = SAMPLE.replace(
      '**Problem** — draft.',
      'Some context first.\n\n**Problem** — draft.'
    );
    const file = parseStatus(withPreamble);
    expect(file.open[1]?.preamble).toBe('Some context first.');
    expect(serializeStatus(file)).toBe(withPreamble);
  });

  it('does not read a bold word inside a field as a new field', () => {
    const file = parseStatus(SAMPLE.replace('inserts the ledger', 'inserts the\n**wrong** ledger'));
    expect(file.open[0]?.fields.map((field) => field.name)).toEqual([
      'Problem',
      'Recommendation',
      'Decision',
      'Alternatives',
      'Answer',
    ]);
  });

  it('does not read a standalone bold line inside a field as a new field', () => {
    const withBoldLine = SAMPLE.replace(
      'inserts the ledger legs',
      'inserts the\n\n**Found**\n\nledger legs'
    );
    const file = parseStatus(withBoldLine);
    expect(file.open[0]?.fields.map((field) => field.name)).toEqual([
      'Problem',
      'Recommendation',
      'Decision',
      'Alternatives',
      'Answer',
    ]);
    expect(file.open[0]?.fields[0]?.text).toContain('**Found**');
    expect(serializeStatus(file)).toBe(withBoldLine);
  });

  it('reads a title with no glyph as a card with no state', () => {
    const legacy = SAMPLE.replace('## ✅ Q2 —', '## Q2 —');
    expect(parseStatus(legacy).open[0]?.state).toBeNull();
  });

  it('accepts a None. placeholder under an empty section', () => {
    const empty = `# Status — x\n\n📊 start\n\n| ✅ done | 🔧 in-flight | ⏸ blocked | ⬜ queued | ❓ open |\n| --- | --- | --- | --- | --- |\n| 0 | none | none | 0 | 0 |\n\n## Open\n\nNone.\n\n## Answered\n`;
    const file = parseStatus(empty);
    expect(file.open).toEqual([]);
    expect(file.answered).toEqual([]);
  });

  it('refuses a file without the two sections', () => {
    const chart =
      '| ✅ done | 🔧 in-flight | ⏸ blocked | ⬜ queued | ❓ open |\n| --- | --- | --- | --- | --- |\n| 0 | none | none | 0 | 0 |';
    expect(() => parseStatus(`# Status — x\n\n📊 s\n\n${chart}\n\n## Open\n`)).toThrow(/Answered/);
  });

  it('refuses a card heading it cannot read', () => {
    expect(() => parseStatus(SAMPLE.replace('## ✅ Q2 —', '## 🎉 Q2 —'))).toThrow(/glyph/);
    expect(() => parseStatus(SAMPLE.replace('# Status — wallet lock order\n', ''))).toThrow(
      /title/
    );

    expect(() => parseStatus(SAMPLE.replace('## Open\n', ''))).toThrow(/Open/);

    expect(() => parseStatus(SAMPLE.replace('## ✅ Q2 —', '## ✅ Q2'))).toThrow(/Q2/);
  });

  it('refuses a chart without a stamp line', () => {
    expect(() => parseStatus(SAMPLE.replace('📊 after T04 audit PASS\n', ''))).toThrow(/📊/);
  });

  it('refuses prose under a section heading that belongs to no card', () => {
    expect(() => parseStatus(SAMPLE.replace('## Open\n', '## Open\n\nstray line\n'))).toThrow(
      /outside any card/
    );
  });

  it('refuses a chart row with fewer than five cells', () => {
    expect(() =>
      parseStatus(SAMPLE.replace('| 5 | T07 | T03 → Q2 | 4 | 1 (1 blocking) |', ''))
    ).toThrow(/chart row/);

    expect(() =>
      parseStatus(SAMPLE.replace('| 5 | T07 | T03 → Q2 | 4 | 1 (1 blocking) |', '| 5 | T07 |'))
    ).toThrow(/five cells/);
  });
});

describe('serializeStatus', () => {
  it('round-trips the sample byte for byte', () => {
    expect(serializeStatus(parseStatus(SAMPLE))).toBe(SAMPLE);
  });

  it('derives the open cell from ready and findings cards and their blocks', () => {
    const file = parseStatus(SAMPLE);
    const [ready, draft] = file.open;
    if (ready === undefined || draft === undefined) throw new Error('fixture has two open cards');
    const findings = { ...draft, state: 'findings' as const, blocks: ['T09'] };
    const withFindings: StatusFile = { ...file, open: [ready, findings] };
    expect(serializeStatus(withFindings)).toContain('| 5 | T07 | T03 → Q2 | 4 | 2 (2 blocking) |');
  });

  it('writes a card with no state without a glyph', () => {
    const file = parseStatus(SAMPLE.replace('## ✅ Q2 —', '## Q2 —'));
    expect(serializeStatus(file)).toContain('\n## Q2 — should');
  });
});

describe('parseCard', () => {
  it('reads one card from a drafted file', () => {
    const card = parseCard(
      '## 📝 Q9 — is it? [blocking T02]\n\n**Problem** — p.\n\n**Recommendation** — r.\n\n**Decision** — d.\n\n**Alternatives** — a.\n'
    );
    expect(card.id).toBe(9);
    expect(card.fields.map((field) => field.text)).toEqual(['p.', 'r.', 'd.', 'a.']);
  });

  it('refuses text holding more than one card', () => {
    expect(() => parseCard('stray\n\n## Q1 — a? [blocks nothing]\n')).toThrow(/before the card/);

    expect(() => parseCard('## Q1 — a?\n\n## Q2 — b?\n')).toThrow(/one card/);
  });
});

describe('a field whose body starts on the line after its lead', () => {
  const FOUR_BULLETS = SAMPLE.replace(
    '**Problem** — `settle.ts:40` inserts the ledger legs before taking the wallet row lock.',
    [
      '**Problem** —',
      '',
      '- Found — `settle.ts:40` inserts the legs before the lock.',
      '- Today — a concurrent settle can deadlock against it.',
      '- After — the lock is taken first and the legs follow.',
      '- Breaks — one more round trip on every settle.',
    ].join('\n')
  );

  it('round-trips byte for byte', () => {
    expect(serializeStatus(parseStatus(FOUR_BULLETS))).toBe(FOUR_BULLETS);
  });

  it('holds the whole block as the field text', () => {
    const problem = parseStatus(FOUR_BULLETS).open[0]?.fields[0];
    expect(problem?.name).toBe('Problem');
    expect(problem?.text.startsWith('- Found — ')).toBe(true);
    expect(problem?.text).toContain('- Breaks — one more round trip on every settle.');
  });
});
