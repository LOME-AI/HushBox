import { describe, expect, it } from 'vitest';
import { parseCard, parseStatus, serializeStatus, type StatusFile } from './format.js';
import {
  answerCard,
  checkStatus,
  editField,
  emptyStatus,
  listLines,
  openCard,
  openFromCard,
  pendingCards,
  reopenCard,
  setChart,
  setState,
  setTitle,
  showCard,
  supersedeCard,
  withdrawCard,
} from './operations.js';

const CHART =
  '| ✅ done | 🔧 in-flight | ⏸ blocked | ⬜ queued | ❓ open |\n| --- | --- | --- | --- | --- |\n| 5 | T07 | T03 → Q2 | 4 | 1 (1 blocking) |';

/** A Problem body carrying the four labels the shape requires. */
const LABELLED_PROBLEM = `- Found — the hold outlives the run.
- Today — a killed run leaves the hold standing.
- After — it expires on its own.
- Breaks — nothing.`;

/** The same Problem, its options weighed in a table instead of an Alternatives field. */
const TABLE_PROBLEM = `${LABELLED_PROBLEM}

| option | why it loses |
| --- | --- |
| expire lazily | nothing reads a stale hold |
| sweep hourly | a second mechanism to keep correct |`;

const CARD_2_PROBLEM = `- Found — \`settle.ts:40\` locks late. The lock is late twice: late here and late there.
- Today — the insert lands before the lock.
- After — the lock is taken first.
- Breaks — nothing.`;

const CARD_2 = `## ✅ Q2 — should the wallet lock move first? [blocking T03]

**Problem** —
${CARD_2_PROBLEM}

**Recommendation** — lock first.

**Decision** — Move the lock.

**Alternatives** — lock after.

**Answer:**`;

const CARD_5 = `## 📝 Q5 — draft? [blocks nothing]

**Problem** —
${LABELLED_PROBLEM}

**Recommendation** — r.

**Decision** — d.

**Alternatives** — a.`;

const CARD_1 = `## ✅ Q1 — expire the hold? [blocking T01]

**Problem** —
${LABELLED_PROBLEM}

**Recommendation** — r.

**Decision** — Expire it.

**Alternatives** — a.

**Answer:** yes

**Work:** T01 (hold TTL).`;

const SAMPLE = `# Status — run\n\n📊 stamp\n\n${CHART}\n\n## Open\n\n${CARD_2}\n\n${CARD_5}\n\n## Answered\n\n${CARD_1}\n`;

function sample(): StatusFile {
  return parseStatus(SAMPLE);
}

/** A card written before the shape was enforced: a bare Problem, a chained Decision, no Alternatives. */
const OLD_SHAPE_CARD = `## Q7 — old shape? [blocks nothing]

**Problem** — a bare line.

**Recommendation** — r.

**Decision** — Move the lock; settle after.`;

/** An open card weighing its options in a table, so removing its Alternatives field is legal. */
const OPEN_TABLE_AND_ALTERNATIVES_CARD = `## 📝 Q13 — a table beside the field? [blocks nothing]

**Problem** —
${TABLE_PROBLEM}

**Recommendation** — r.

**Decision** — d.

**Alternatives** — a.

**Answer:**`;

/** A card whose bodies all sit under their leads: bulleted, blank-line-spaced, and prose. */
const UNDER_LEAD_CARD = `## 📝 Q6 — bodies under their leads? [blocks nothing]

**Problem** —
${LABELLED_PROBLEM}

**Recommendation** —
- lock first.
- settle after.

**Decision** —
the lock moves first.

**Alternatives** —

- lock after.`;

/** A card carrying the collapsed rendering: a bulleted Problem riding its lead line. */
const COLLAPSED_CARD = `## 📝 Q10 — collapsed onto its lead? [blocks nothing]

**Problem** — ${LABELLED_PROBLEM}

**Recommendation** — r.

**Decision** — d.

**Alternatives** — a.`;

/** An answered card carrying both an option table and the Alternatives field the table replaces. */
const TABLE_AND_ALTERNATIVES_CARD = `## Q8 — both at once? [blocks nothing]

**Problem** —
${TABLE_PROBLEM}

**Recommendation** — r.

**Decision** — d.

**Alternatives** — a.

**Answer:** yes

**Work:** T01 (hold TTL).`;

/** The same pairing, carrying a further field no shape rule governs. */
const TABLE_ALTERNATIVES_AND_SPARE_CARD = `## 📝 Q12 — a spare field beside the pair? [blocks nothing]

**Problem** —
${TABLE_PROBLEM}

**Recommendation** — r.

**Decision** — d.

**Alternatives** — a.

**Notes** — a note no rule reads.`;

/** A card weighing its options in a table beside an Alternatives field holding nothing. */
const TABLE_AND_EMPTY_ALTERNATIVES_CARD = `## Q11 — an empty field beside a table? [blocks nothing]

**Problem** —
${TABLE_PROBLEM}

**Recommendation** — r.

**Decision** — d.

**Alternatives** —`;

/** A card withdrawn on a false premise: one field, by design. */
const WITHDRAWN_CARD = `## 📝 Q9 — a false premise? [blocks nothing]

**Problem** — the hold already expires, so there was nothing to decide.

**Answer:** withdrawn

**Work:** none — withdrawn`;

/** A file holding the given card text in each section; either may be empty. */
function fileOf(open: string, answered: string): StatusFile {
  return parseStatus(
    `# Status — run\n\n📊 stamp\n\n${CHART}\n\n## Open\n\n${open}\n\n## Answered\n\n${answered}\n`
  );
}

const DRAFT = {
  question: 'round half-even?',
  blocks: ['T09'],
  problem: LABELLED_PROBLEM,
  recommendation: 'r',
  decision: 'd',
  alternatives: 'a',
};

describe('the fixture file', () => {
  it('round-trips byte-for-byte, so every expectation below reads a canonical file', () => {
    expect(serializeStatus(sample())).toBe(SAMPLE);
  });

  it('keeps an Alternatives field holding nothing exactly as written, which the rule reads as present', () => {
    expect(serializeStatus(fileOf(TABLE_AND_EMPTY_ALTERNATIVES_CARD, ''))).toContain(
      TABLE_AND_EMPTY_ALTERNATIVES_CARD
    );
  });

  it('keeps a card carrying a field no rule governs exactly as written', () => {
    expect(serializeStatus(fileOf(TABLE_ALTERNATIVES_AND_SPARE_CARD, ''))).toContain(
      TABLE_ALTERNATIVES_AND_SPARE_CARD
    );
  });

  it('keeps an open card weighing its options in a table exactly as written', () => {
    expect(serializeStatus(fileOf(OPEN_TABLE_AND_ALTERNATIVES_CARD, ''))).toContain(
      OPEN_TABLE_AND_ALTERNATIVES_CARD
    );
  });
});

describe('openCard', () => {
  it('allocates the next id across both sections and inserts a drafting card at the top of Open', () => {
    const { file, id } = openCard(sample(), DRAFT);
    expect(id).toBe(6);
    expect(file.open[0]).toMatchObject({ id: 6, state: 'drafting', blocks: ['T09'] });
    expect(file.open[0]?.fields.map((field) => `${field.name}:${field.text}`)).toEqual([
      `Problem:${LABELLED_PROBLEM}`,
      'Recommendation:r',
      'Decision:d',
      'Alternatives:a',
    ]);
  });

  it('refuses an empty field', () => {
    expect(() => openCard(sample(), { ...DRAFT, decision: '' })).toThrow(/Decision/);
  });

  it('refuses a Problem missing one of its four labels, naming the one it lacks', () => {
    const problem = LABELLED_PROBLEM.split('\n').slice(0, 3).join('\n');
    expect(() => openCard(sample(), { ...DRAFT, problem })).toThrow(/no Breaks label/);
  });

  it('refuses a Decision holding a semicolon', () => {
    expect(() =>
      openCard(sample(), { ...DRAFT, decision: 'Move the lock; settle after.' })
    ).toThrow(/semicolon/);
  });

  it.each(['then', 'until', 'at which point'])('refuses a Decision holding %s', (token) => {
    expect(() =>
      openCard(sample(), { ...DRAFT, decision: `Move the lock ${token} settle.` })
    ).toThrow(`holds "${token}"`);
  });

  it('matches a banned word whatever its case', () => {
    expect(() => openCard(sample(), { ...DRAFT, decision: 'Move the lock UNTIL settle.' })).toThrow(
      /holds "until"/
    );
  });

  it('refuses an Alternatives field beside an option table in the Problem', () => {
    expect(() => openCard(sample(), { ...DRAFT, problem: TABLE_PROBLEM })).toThrow(
      /takes no Alternatives field/
    );
  });

  it('takes an option table, writing no Alternatives field', () => {
    const { file } = openCard(sample(), {
      ...DRAFT,
      problem: TABLE_PROBLEM,
      alternatives: undefined,
    });
    expect(file.open[0]?.fields.map((field) => field.name)).toEqual([
      'Problem',
      'Recommendation',
      'Decision',
    ]);
  });

  it('refuses a card carrying neither an option table nor an Alternatives field', () => {
    expect(() => openCard(sample(), { ...DRAFT, alternatives: undefined })).toThrow(
      /needs an Alternatives field/
    );
  });

  it('takes a longer word that merely contains a banned token', () => {
    const decision = 'Move the lock, thence over untilled ground.';
    const { file } = openCard(sample(), { ...DRAFT, decision });
    expect(file.open[0]?.fields.find((field) => field.name === 'Decision')?.text).toBe(decision);
  });
});

describe('the lead a field is written with', () => {
  const written = (): string => {
    const { file } = openCard(emptyStatus('a run'), { ...DRAFT, problem: LABELLED_PROBLEM });
    return serializeStatus(file);
  };

  it('starts a bulleted body on the line after its lead', () => {
    expect(written()).toContain(`**Problem** —\n${LABELLED_PROBLEM}`);
  });

  it('leaves a body that opens with prose on the lead line', () => {
    expect(written()).toContain('**Recommendation** — r');
  });

  it('round-trips a four-bullet Problem it wrote byte-for-byte', () => {
    const text = written();
    expect(serializeStatus(parseStatus(text))).toBe(text);
  });
});

describe('the lead an edited field is written with', () => {
  const written = (card: string, id: number, name: string, body: string): string =>
    serializeStatus(editField(fileOf(card, ''), id, name, { kind: 'text', text: body }));

  const intoBullets = (): string => written(OLD_SHAPE_CARD, 7, 'Problem', LABELLED_PROBLEM);
  const outOfBullets = (): string => written(UNDER_LEAD_CARD, 6, 'Recommendation', 'lock first.');
  const staysBulleted = (): string =>
    written(UNDER_LEAD_CARD, 6, 'Alternatives', '- lock after.\n- or never.');
  const staysProse = (): string => written(UNDER_LEAD_CARD, 6, 'Decision', 'the lock moves last.');
  const staysBulletedOneBreak = (): string =>
    written(UNDER_LEAD_CARD, 6, 'Recommendation', '- lock first.\n- then never.');
  const staysCollapsed = (): string =>
    written(COLLAPSED_CARD, 10, 'Problem', LABELLED_PROBLEM.replace('nothing.', 'no reader.'));

  it('starts a body edited into bullets on the line after its lead', () => {
    expect(intoBullets()).toContain(`**Problem** —\n${LABELLED_PROBLEM}`);
  });

  it('brings a body edited out of bullets back onto its lead line', () => {
    expect(outOfBullets()).toContain('**Recommendation** — lock first.');
  });

  it('leaves the break a field was read with when the body stays bulleted', () => {
    expect(staysBulleted()).toContain('**Alternatives** —\n\n- lock after.\n- or never.');
  });

  it('leaves a prose field edited to other prose exactly as it was read', () => {
    expect(staysProse()).toContain('**Decision** —\nthe lock moves last.');
  });

  it('keeps a single break under the lead of a body that stays bulleted', () => {
    expect(staysBulletedOneBreak()).toContain('**Recommendation** —\n- lock first.\n- then never.');
  });

  it('gives a bulleted body collapsed onto its lead line the break it lacks', () => {
    expect(staysCollapsed()).toContain(
      `**Problem** —\n${LABELLED_PROBLEM.replace('nothing.', 'no reader.')}`
    );
  });

  it('round-trips each of those edits byte-for-byte', () => {
    for (const text of [
      intoBullets(),
      outOfBullets(),
      staysBulleted(),
      staysProse(),
      staysBulletedOneBreak(),
      staysCollapsed(),
    ]) {
      expect(serializeStatus(parseStatus(text))).toBe(text);
    }
  });
});

describe('the lead every write path writes', () => {
  const underLead = `**Problem** —\n${LABELLED_PROBLEM}`;
  const fromOpen = (apply: (file: StatusFile) => StatusFile): string =>
    serializeStatus(apply(fileOf(COLLAPSED_CARD, '')));
  const fromAnswered = (apply: (file: StatusFile) => StatusFile): string =>
    serializeStatus(apply(fileOf('', COLLAPSED_CARD)));

  it('reads a card whose bulleted Problem rides its lead line, so each path below starts collapsed', () => {
    expect(serializeStatus(fileOf(COLLAPSED_CARD, ''))).toContain(
      `**Problem** — ${LABELLED_PROBLEM}`
    );
  });

  it('gives the break to a card opened from a drafted file', () => {
    const { file } = openFromCard(emptyStatus('a run'), parseCard(COLLAPSED_CARD));
    expect(serializeStatus(file)).toContain(underLead);
  });

  it('gives the break to a card whose glyph moves', () => {
    expect(fromOpen((file) => setState(file, 10, 'ready'))).toContain(underLead);
  });

  it('gives the break to a card whose question is reframed', () => {
    expect(fromOpen((file) => setTitle(file, 10, { question: 'moved?' }))).toContain(underLead);
  });

  it('gives the break to a card whose other field is edited', () => {
    expect(
      fromOpen((file) => editField(file, 10, 'Recommendation', { kind: 'text', text: 'r2.' }))
    ).toContain(underLead);
  });

  it('gives the break to a card moved to Answered', () => {
    expect(fromOpen((file) => answerCard(file, 10, { text: 'y', work: 'w' }).file)).toContain(
      underLead
    );
  });

  it('gives the break to an answered card reopened', () => {
    expect(fromAnswered((file) => reopenCard(file, 10, 'the premise was false'))).toContain(
      underLead
    );
  });

  it('gives the break to an answered card superseded', () => {
    expect(
      fromAnswered((file) => supersedeCard(file, 10, { text: 'n', work: 'w' }).file)
    ).toContain(underLead);
  });

  it('round-trips a card it gave the break to byte-for-byte', () => {
    const text = fromOpen((file) => setState(file, 10, 'ready'));
    expect(serializeStatus(parseStatus(text))).toBe(text);
  });
});

describe('openFromCard', () => {
  it('takes the drafted fields and assigns its own id and state', () => {
    const drafted = parseCard(CARD_1.replace('Q1', 'Q99'));
    const { file, id } = openFromCard(sample(), drafted);
    expect(id).toBe(6);
    expect(file.open[0]?.state).toBe('drafting');
    expect(file.open[0]?.fields.some((field) => field.name === 'Answer')).toBe(false);
  });

  it('refuses a drafted card whose Problem lacks a label', () => {
    const drafted = parseCard(CARD_1.replace('Q1', 'Q99').replace('- Breaks — nothing.', 'x'));
    expect(() => openFromCard(sample(), drafted)).toThrow(/no Breaks label/);
  });

  it('refuses a drafted card whose Alternatives field sits empty beside an option table', () => {
    expect(() => openFromCard(sample(), parseCard(TABLE_AND_EMPTY_ALTERNATIVES_CARD))).toThrow(
      /takes no Alternatives field/
    );
  });

  it('refuses a drafted card missing a canonical field', () => {
    expect(() =>
      openFromCard(sample(), parseCard('## Q9 — q? [blocks nothing]\n\n**Problem** — p.'))
    ).toThrow(/Recommendation/);
  });
});

describe('editField', () => {
  const problem = (file: StatusFile): string | undefined =>
    file.open[0]?.fields.find((field) => field.name === 'Problem')?.text;

  it('replaces a whole field', () => {
    const file = editField(sample(), 2, 'Problem', { kind: 'text', text: LABELLED_PROBLEM });
    expect(problem(file)).toBe(LABELLED_PROBLEM);
  });

  it('refuses a Decision edit that introduces a banned token', () => {
    expect(() =>
      editField(sample(), 2, 'Decision', { kind: 'text', text: 'Lock, then settle.' })
    ).toThrow(/holds "then"/);
  });

  it('refuses a Problem edit that drops a label', () => {
    const shorn = LABELLED_PROBLEM.split('\n').slice(0, 3).join('\n');
    expect(() => editField(sample(), 2, 'Problem', { kind: 'text', text: shorn })).toThrow(
      /no Breaks label/
    );
  });

  it('follows the field it is handed: the text refused on Problem is taken on Recommendation', () => {
    expect(() => editField(sample(), 2, 'Problem', { kind: 'text', text: 'a bare line' })).toThrow(
      /no Found, Today, After, Breaks labels/
    );
    const file = editField(sample(), 2, 'Recommendation', { kind: 'text', text: 'a bare line' });
    expect(file.open[0]?.fields.find((field) => field.name === 'Recommendation')?.text).toBe(
      'a bare line'
    );
  });

  it('applies the Problem rule to every open card, whatever its id', () => {
    expect(() => editField(sample(), 5, 'Problem', { kind: 'text', text: 'a bare line' })).toThrow(
      /Q5: the Problem has no Found, Today, After, Breaks labels/
    );
  });

  it('replaces an exact string that occurs once', () => {
    const file = editField(sample(), 2, 'Problem', {
      kind: 'replace',
      old: 'locks late',
      with: 'locks after the insert',
    });
    expect(problem(file)).toContain('locks after the insert');
  });

  it('refuses a string that occurs more than once', () => {
    expect(() =>
      editField(sample(), 2, 'Problem', { kind: 'replace', old: 'late', with: 'x' })
    ).toThrow(/4 times/);
  });

  it('refuses a string that occurs nowhere', () => {
    expect(() =>
      editField(sample(), 2, 'Problem', { kind: 'replace', old: 'absent', with: 'x' })
    ).toThrow(/0 times/);
  });

  it('appends a paragraph', () => {
    expect(problem(editField(sample(), 2, 'Problem', { kind: 'append', text: 'more' }))).toMatch(
      /nothing\.\n\nmore$/
    );
  });

  it('refuses the Answer, Work, and Findings fields', () => {
    expect(() => editField(sample(), 2, 'Answer', { kind: 'text', text: 'x' })).toThrow(/Answer/);
  });

  it('refuses a card not in Open', () => {
    expect(() => editField(sample(), 1, 'Problem', { kind: 'text', text: 'x' })).toThrow(/Q1/);
  });

  it('sends a title or blocks edit to the verb that owns the title line', () => {
    expect(() => editField(sample(), 2, 'title', { kind: 'text', text: 'x?' })).toThrow(
      /cards title/
    );
    expect(() => editField(sample(), 2, 'blocks', { kind: 'text', text: 'T09' })).toThrow(
      /cards title/
    );
  });

  it('refuses a field the card does not carry', () => {
    expect(() => editField(sample(), 2, 'Grade', { kind: 'text', text: 'x' })).toThrow(/Grade/);
  });

  it('removes the named field and leaves the others in place', () => {
    const file = editField(fileOf(OPEN_TABLE_AND_ALTERNATIVES_CARD, ''), 13, 'Alternatives', {
      kind: 'remove',
    });
    expect(file.open[0]?.fields.map((field) => field.name)).toEqual([
      'Problem',
      'Recommendation',
      'Decision',
      'Answer',
    ]);
    expect(showCard(file, 13)).not.toContain('**Alternatives**');
  });

  it.each(['Problem', 'Recommendation', 'Decision'])(
    'refuses removing %s, which every card carries',
    (name) => {
      expect(() => editField(sample(), 2, name, { kind: 'remove' })).toThrow(
        `${name} is a field every card carries`
      );
    }
  );

  it('refuses removing a field a verb owns', () => {
    expect(() => editField(sample(), 2, 'Answer', { kind: 'remove' })).toThrow(/own verb/);
  });

  it('refuses a removal that leaves the card carrying a defect it did not carry', () => {
    expect(() => editField(sample(), 2, 'Alternatives', { kind: 'remove' })).toThrow(
      'Q2: the Problem weighs no options in a table, so the card needs an Alternatives field'
    );
  });

  it('takes a removal that repairs the card', () => {
    const file = editField(fileOf(TABLE_AND_ALTERNATIVES_CARD, ''), 8, 'Alternatives', {
      kind: 'remove',
    });
    expect(showCard(file, 8)).not.toContain('**Alternatives**');
  });

  it('takes an unrelated removal from a card already carrying the defect', () => {
    const file = editField(fileOf(TABLE_ALTERNATIVES_AND_SPARE_CARD, ''), 12, 'Notes', {
      kind: 'remove',
    });
    expect(showCard(file, 12)).not.toContain('**Notes**');
    expect(showCard(file, 12)).toContain('**Alternatives** — a.');
  });
});

describe('setState', () => {
  it('moves a card through review to ready', () => {
    const file = setState(setState(sample(), 5, 'review'), 5, 'ready');
    expect(file.open.find((card) => card.id === 5)?.state).toBe('ready');
  });

  it('records findings beneath Alternatives and marks the card', () => {
    const file = setState(sample(), 2, 'findings', 'UNRESOLVED: "the fleet"');
    const card = file.open[0];
    expect(card?.state).toBe('findings');
    expect(card?.fields.map((field) => field.name)).toEqual([
      'Problem',
      'Recommendation',
      'Decision',
      'Alternatives',
      'Findings',
      'Answer',
    ]);
  });

  it('files findings after the last canonical field the card carries', () => {
    const { file, id } = openCard(sample(), {
      ...DRAFT,
      problem: TABLE_PROBLEM,
      alternatives: undefined,
    });
    expect(showCard(setState(file, id, 'findings', 'UNRESOLVED: "the fleet"'), id)).toContain(
      '**Decision** — d\n\n**Findings** — UNRESOLVED: "the fleet"'
    );
  });

  it('files findings after Alternatives on a card that carries one', () => {
    expect(showCard(setState(sample(), 2, 'findings', 'UNRESOLVED: "the fleet"'), 2)).toContain(
      '**Alternatives** — lock after.\n\n**Findings** — UNRESOLVED: "the fleet"'
    );
  });

  it('refuses findings without text', () => {
    expect(() => setState(sample(), 2, 'findings')).toThrow(/findings/);
  });

  it('writes no findings text once the card has left the findings state', () => {
    const filed = setState(sample(), 2, 'findings', 'UNRESOLVED: "the fleet"');
    const written = serializeStatus(setState(filed, 2, 'ready'));
    expect(written).not.toContain('Findings');
    expect(written).not.toContain('the fleet');
  });
});

describe('setTitle', () => {
  const titleOf = (file: StatusFile): string | undefined => file.open[0]?.question;

  it('replaces the question text and leaves the blocking tag alone', () => {
    const file = setTitle(sample(), 2, { question: 'should the lock move at all?' });
    expect(titleOf(file)).toBe('should the lock move at all?');
    expect(file.open[0]?.blocks).toEqual(['T03']);
  });

  it('sets the blocking tag and leaves the question alone', () => {
    const file = setTitle(sample(), 2, { blocks: ['T07', 'T08'] });
    expect(file.open[0]?.blocks).toEqual(['T07', 'T08']);
    expect(titleOf(file)).toBe('should the wallet lock move first?');
  });

  it('clears the blocking tag', () => {
    expect(setTitle(sample(), 2, { blocks: [] }).open[0]?.blocks).toEqual([]);
  });

  it('changes both at once', () => {
    const file = setTitle(sample(), 2, { question: 'lock first?', blocks: ['T09'] });
    expect(file.open[0]).toMatchObject({ question: 'lock first?', blocks: ['T09'] });
  });

  it('refuses a change that names nothing', () => {
    expect(() => setTitle(sample(), 2, {})).toThrow(/nothing to change/);
  });

  it('refuses an empty question', () => {
    expect(() => setTitle(sample(), 2, { question: '  ' })).toThrow(/question/);
  });

  it('refuses a card not in Open', () => {
    expect(() => setTitle(sample(), 1, { question: 'x?' })).toThrow(/Q1/);
  });
});

describe('answerCard', () => {
  it('moves the card whole to the top of Answered with Answer and Work appended', () => {
    const { file, ledgerLine } = answerCard(sample(), 2, {
      text: 'yes, lock first',
      work: 'T09 (lock order).',
    });
    expect(file.open.map((card) => card.id)).toEqual([5]);
    expect(file.answered.map((card) => card.id)).toEqual([2, 1]);
    const answered = file.answered[0];
    expect(answered?.fields.at(-2)).toMatchObject({ name: 'Answer', text: 'yes, lock first' });
    expect(answered?.fields.at(-1)).toMatchObject({ name: 'Work', text: 'T09 (lock order).' });
    expect(ledgerLine).toBe('- Q2 ruled: "yes, lock first" → Work: T09 (lock order).');
  });

  it('takes the answer the human wrote into the file when no text is given', () => {
    const start = editFieldUnchecked(sample(), 2, 'Answer', 'no');
    const { file } = answerCard(start, 2, { work: 'none — deferred' });
    expect(file.answered[0]?.fields.find((field) => field.name === 'Answer')?.text).toBe('no');
  });

  it('refuses when neither an argument nor the file holds an answer', () => {
    expect(() => answerCard(sample(), 2, { work: 'w' })).toThrow(/no answer/);
  });

  it('keeps the glyph so a later reader sees what the decision was made on', () => {
    const { file } = answerCard(sample(), 2, { text: 'yes', work: 'w' });
    expect(file.answered[0]?.state).toBe('ready');
  });
});

/** A card with the human's own Answer line filled in, as the file looks before `answer` runs. */
function editFieldUnchecked(file: StatusFile, id: number, name: string, text: string): StatusFile {
  return {
    ...file,
    open: file.open.map((card) =>
      card.id === id
        ? {
            ...card,
            fields: card.fields.map((field) => (field.name === name ? { ...field, text } : field)),
          }
        : card
    ),
  };
}

describe('pendingCards', () => {
  it('lists open cards whose Answer line the human filled', () => {
    expect(pendingCards(sample())).toEqual([]);
    expect(
      pendingCards(editFieldUnchecked(sample(), 2, 'Answer', 'no')).map((card) => card.id)
    ).toEqual([2]);
  });
});

describe('reopenCard', () => {
  it('moves an answered card back to Open with the correction folded into Problem', () => {
    const file = reopenCard(sample(), 1, 'the hold already expires');
    expect(file.open.map((card) => card.id)).toEqual([1, 2, 5]);
    const problem = file.open[0]?.fields.find((field) => field.name === 'Problem')?.text;
    expect(problem).toBe(`${LABELLED_PROBLEM}\n\nCorrection — the hold already expires`);
  });

  it('refuses a card not in Answered', () => {
    expect(() => reopenCard(sample(), 2, 'x')).toThrow(/Q2/);
  });
});

describe('supersedeCard', () => {
  it('appends a second Answer and Work pair marked as superseding', () => {
    const { file, ledgerLine } = supersedeCard(sample(), 1, {
      text: 'no, keep it',
      work: 'T01 reverted.',
    });
    const names = file.answered[0]?.fields.map((field) => field.name);
    expect(names?.slice(-4)).toEqual(['Answer', 'Work', 'Answer', 'Work']);
    expect(file.answered[0]?.fields.at(-2)?.text).toBe('no, keep it (supersedes the answer above)');
    expect(ledgerLine).toContain('supersedes');
  });

  it('leaves the other answered cards untouched', () => {
    const file = sample();
    const first = file.answered[0];
    if (first === undefined) throw new Error('fixture has no answered card');
    const twin = { ...first, id: 9 };
    const { file: after } = supersedeCard({ ...file, answered: [twin, ...file.answered] }, 1, {
      text: 'n',
      work: 'w',
    });
    expect(after.answered.map((card) => card.fields.length)).toEqual([6, 8]);
  });
});

describe('withdrawCard', () => {
  const reason = 'the hold already expires, so there was nothing to decide';

  it('collapses the card to its reason and moves it to Answered', () => {
    const { file, ledgerLine } = withdrawCard(sample(), 2, reason);
    expect(file.open.map((card) => card.id)).toEqual([5]);
    expect(file.answered.map((card) => card.id)).toEqual([2, 1]);
    expect(showCard(file, 2)).toBe(
      `## ✅ Q2 — should the wallet lock move first? [blocking T03]\n\n**Problem** — ${reason}\n\n**Answer:** withdrawn\n\n**Work:** none — withdrawn`
    );
    expect(ledgerLine).toBe(`- Q2 withdrawn: "${reason}"`);
  });

  it('leaves a card the whole-file check passes', () => {
    expect(checkStatus(withdrawCard(sample(), 2, reason).file)).toEqual([]);
  });

  it('refuses a card already in Answered', () => {
    expect(() => withdrawCard(sample(), 1, reason)).toThrow(/Q1 is not in Open/);
  });
});

describe('checkStatus', () => {
  it('passes a canonical file', () => {
    expect(checkStatus(sample())).toEqual([]);
  });

  it('names a card missing a canonical field, a duplicate id, and an answered card without Work', () => {
    const file = sample();
    const broken: StatusFile = {
      ...file,
      open: [...file.open, { ...file.open[1]!, fields: file.open[1]!.fields.slice(1) }],
      answered: file.answered.map((card) => ({ ...card, fields: card.fields.slice(0, -1) })),
    };
    const problems = checkStatus(broken);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Q5 .*Problem/),
        expect.stringMatching(/Q5 .*twice/),
        expect.stringMatching(/Q1 .*Work/),
      ])
    );
  });

  it('passes a card the tool wrote itself, option table and all', () => {
    const { file } = openCard(emptyStatus('a run'), {
      ...DRAFT,
      problem: TABLE_PROBLEM,
      alternatives: undefined,
    });
    expect(checkStatus(file)).toEqual([]);
  });

  it('reports every shape defect of an open card, naming the card and its section', () => {
    expect(checkStatus(fileOf(OLD_SHAPE_CARD, ''))).toEqual([
      'Q7 (Open): the Problem has no Found, Today, After, Breaks labels',
      'Q7 (Open): the Decision holds a semicolon',
      'Q7 (Open): the Problem weighs no options in a table, so the card needs an Alternatives field',
    ]);
  });

  it('reports the shape of an answered card too, exempting neither section', () => {
    expect(checkStatus(fileOf('', TABLE_AND_ALTERNATIVES_CARD))).toEqual([
      "Q8 (Answered): the Problem's option table already holds every loser's reason, so the card takes no Alternatives field",
    ]);
  });

  it('reports an Alternatives field holding nothing beside an option table', () => {
    expect(checkStatus(fileOf(TABLE_AND_EMPTY_ALTERNATIVES_CARD, ''))).toEqual([
      "Q11 (Open): the Problem's option table already holds every loser's reason, so the card takes no Alternatives field",
    ]);
  });

  it('passes that same card once the field is gone', () => {
    const without = TABLE_AND_EMPTY_ALTERNATIVES_CARD.replace('\n\n**Alternatives** —', '');
    expect(checkStatus(fileOf(without, ''))).toEqual([]);
  });

  it('takes an Alternatives field holding nothing where the Problem weighs no options', () => {
    const card = COLLAPSED_CARD.replace('**Alternatives** — a.', '**Alternatives** —');
    expect(checkStatus(fileOf(card, ''))).toEqual([]);
  });

  it('exempts a withdrawn card from the field checks, since it holds one field by design', () => {
    expect(checkStatus(fileOf('', WITHDRAWN_CARD))).toEqual([]);
  });

  it('still wants the Work line of a withdrawn card', () => {
    const unruled = WITHDRAWN_CARD.replace('\n\n**Work:** none — withdrawn', '');
    expect(checkStatus(fileOf('', unruled))).toEqual(['Q9 (Answered) has no Work line']);
  });
});

describe('listLines', () => {
  it('prints one line per card with glyph, id, question, and blocks', () => {
    expect(listLines(sample(), 'open')).toEqual([
      '✅ Q2 — should the wallet lock move first? [blocking T03]',
      '📝 Q5 — draft? [blocks nothing]',
    ]);
    expect(listLines(sample(), 'ready')).toEqual([
      '✅ Q2 — should the wallet lock move first? [blocking T03]',
    ]);
    expect(listLines(sample(), 'answered')).toEqual([
      '✅ Q1 — expire the hold? [blocking T01] → yes',
    ]);
  });

  it('prints an answered card with no Answer line as an empty answer, and a glyph-less card bare', () => {
    const file = sample();
    const first = file.answered[0];
    if (first === undefined) throw new Error('fixture has no answered card');
    const bare = { ...first, state: null, fields: first.fields.slice(0, 4) };
    expect(listLines({ ...file, answered: [bare] }, 'answered')).toEqual([
      'Q1 — expire the hold? [blocking T01] → ',
    ]);
  });
});

describe('showCard', () => {
  it('prints the whole card or one field', () => {
    expect(showCard(sample(), 1)).toBe(CARD_1);
    expect(showCard(sample(), 1, 'Decision')).toBe('Expire it.');
  });

  it('refuses an unknown id and an unknown field', () => {
    expect(() => showCard(sample(), 7)).toThrow(/Q7/);
    expect(() => showCard(sample(), 1, 'Nope')).toThrow(/Nope/);
  });
});

describe('setChart', () => {
  it('replaces the task cells and the stamp', () => {
    const file = setChart(sample(), {
      stamp: 'after T05',
      done: '6',
      inFlight: 'T08',
      blocked: 'none',
      queued: '3',
    });
    expect(file.chart).toEqual({
      stamp: 'after T05',
      done: '6',
      inFlight: 'T08',
      blocked: 'none',
      queued: '3',
    });
  });

  it('marks an idle chart in the stamp', () => {
    const file = setChart(
      sample(),
      { stamp: 'T03 waits on Q2', done: '6', inFlight: 'none', blocked: 'T03 → Q2', queued: '0' },
      true
    );
    expect(file.chart.stamp).toBe('idle — T03 waits on Q2');
  });
});

describe('emptyStatus', () => {
  it('builds a file carrying the chart and both sections and no cards', () => {
    const empty =
      '| ✅ done | 🔧 in-flight | ⏸ blocked | ⬜ queued | ❓ open |\n| --- | --- | --- | --- | --- |\n| 0 | none | none | 0 | 0 (0 blocking) |';

    expect(serializeStatus(emptyStatus('a run'))).toBe(
      `# Status — a run\n\n📊 created\n\n${empty}\n\n## Open\n\n## Answered\n`
    );
  });
});
