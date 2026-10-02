import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatBrief,
  formatContestBrief,
  formatFindingLine,
  formatQuestionsBrief,
} from './brief.ts';
import { parseFinding } from './parse.ts';
import type { Finding, ProgressNote, Question } from './types.ts';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'test-fixtures');

function load(name: string): Finding {
  const filePath = path.join(FIXTURE_DIR, `${name}.md`);
  const result = parseFinding(readFileSync(filePath, 'utf8'), filePath);
  if (!result.ok) throw new Error(`fixture ${name} failed to parse`);
  return result.value;
}

/**
 * The fixture's own agent note and the human reply to it. Tests build threads by
 * re-texting these rather than writing note literals, so no test carries a date.
 */
function exchange(finding: Finding): { opening: ProgressNote; answer: ProgressNote } {
  const [opening, answer] = finding.progress.notes;
  if (opening === undefined || answer === undefined) {
    throw new Error('fixture ruled-history no longer carries an agent note and a reply');
  }
  return { opening, answer };
}

/** The role-labelled note lines a brief prints, in the order it printed them. */
function noteLinesOf(brief: string): string[] {
  return brief.split('\n').filter((line) => /^(?:Note|Reply) \(/.test(line));
}

/** The question-section lines a brief prints, in the order it printed them. */
function questionLinesOf(brief: string): string[] {
  return brief
    .split('\n')
    .filter((line) => /^(?:Answered question |Unanswered question |Answer[,:])/.test(line));
}

/**
 * The fixture's own answered question, so no test writes a date of its own. It
 * was asked and answered on different days, which is what lets an assertion on
 * the answer's stamp fail if the brief prints the day it was asked instead.
 */
function answered(finding: Finding): { text: string; answer: string; at: string } {
  const question = finding.questions[0];
  const answer = question?.answer ?? null;
  const at = question?.answered_at ?? null;
  if (question === undefined || answer === null || at === null) {
    throw new Error('fixture ruled-history no longer carries an answered question');
  }
  return { text: question.text, answer, at };
}

/** The fixture's own unanswered question, on the same terms. */
function unanswered(finding: Finding): Question {
  const question = finding.questions[0];
  if (question?.answer !== null) {
    throw new Error('fixture question-open no longer carries an unanswered question');
  }
  return question;
}

describe('formatFindingLine', () => {
  it('names the id, state, severity, area and title in fixed columns', () => {
    expect(formatFindingLine(load('question-open'))).toBe(
      'WL-23-B   open            medium    apps/api      The dispatcher re-arms before dead-lettering, so an exhausted row waits a full pass'
    );
  });

  it('shows the progress status once work has started', () => {
    expect(formatFindingLine(load('ruled-history'))).toContain('ruled/in-progress');
  });

  it('keeps a separator after a value wider than its column', () => {
    const finding: Finding = { ...load('question-open'), area: 'apps/api/src/slices/admin' };
    expect(formatFindingLine(finding)).toContain('apps/api/src/slices/admin The dispatcher');
  });
});

describe('formatBrief', () => {
  it('opens with the ruling, before the body', () => {
    const brief = formatBrief(load('ruled-history'));
    expect(brief.indexOf('Ruling: option B')).toBeLessThan(brief.indexOf('What this is.'));
  });

  it('says the ruling text outranks the option prose', () => {
    expect(formatBrief(load('ruled-history'))).toContain(
      'The ruling text outranks the option prose.'
    );
  });

  it('carries the ruling text and note', () => {
    const brief = formatBrief(load('ruled-history'));
    expect(brief).toContain('“Estimated” must never be silent.');
    expect(brief).toContain('Note: Keep fee application at the port seam.');
  });

  it('includes the chosen option and leaves the others out', () => {
    const brief = formatBrief(load('ruled-history'));
    expect(brief).toContain('Option B: Treat zero as missing and flag the estimate');
    expect(brief).not.toContain('Treat zero as authoritative');
  });

  it('lists every option when the finding is not ruled', () => {
    const brief = formatBrief(load('open-two-options'));
    expect(brief).toContain('Option A');
    expect(brief).toContain('Option B');
  });

  it('says a finding is unruled rather than inventing a ruling', () => {
    expect(formatBrief(load('open-two-options'))).toContain('Ruling: none yet');
  });

  it('reports a denial and its reason', () => {
    const brief = formatBrief(load('denied'));
    expect(brief).toContain('Denied by human');
    expect(brief).toContain('already registered with a registered inverse');
  });

  it('prints an answered question with the answer it was given', () => {
    const finding = load('ruled-history');
    const settled = answered(finding);
    const brief = formatBrief(finding);
    expect(brief).toContain(`Answered question 0: ${settled.text}`);
    expect(brief).toContain(`Answer, at ${settled.at}: ${settled.answer}`);
  });

  it('leaves the question section out when the finding carries no questions', () => {
    expect(questionLinesOf(formatBrief(load('no-options')))).toEqual([]);
  });

  it('keeps the questions in the order the finding records them', () => {
    const finding = load('ruled-history');
    const settled = answered(finding);
    const open = unanswered(load('question-open'));
    const brief = formatBrief({ ...finding, questions: [open, ...finding.questions] });
    expect(questionLinesOf(brief)).toEqual([
      `Unanswered question 0: ${open.text}`,
      `Answered question 1: ${settled.text}`,
      `Answer, at ${settled.at}: ${settled.answer}`,
    ]);
  });

  it('prints an answer that records no day without a stamp', () => {
    const finding = load('ruled-history');
    const settled = answered(finding);
    const brief = formatBrief({
      ...finding,
      questions: finding.questions.map((question) => ({ ...question, answered_at: null })),
    });
    expect(brief).toContain(`Answer: ${settled.answer}`);
  });

  it('reports the progress, the agent last word and the reply to it', () => {
    const brief = formatBrief(load('ruled-history'));
    expect(brief).toContain('Progress: in-progress');
    expect(brief).toContain('Note (agent): Reproduced with a zero-cost response.');
    expect(brief).toContain('Reply (human): Ship the flag first.');
  });

  it('prints every note of a thread, in the order they were recorded', () => {
    const finding = load('ruled-history');
    const { opening, answer } = exchange(finding);
    const brief = formatBrief({
      ...finding,
      progress: {
        ...finding.progress,
        notes: [
          { ...opening, text: 'Reproduced with a zero-cost response.' },
          { ...answer, text: 'Flag it rather than dropping it.' },
          { ...opening, text: 'Blocked on which option to carry out.' },
          { ...answer, text: 'Carry out option B.' },
        ],
      },
    });
    expect(noteLinesOf(brief)).toEqual([
      'Note (agent): Reproduced with a zero-cost response.',
      'Reply (human): Flag it rather than dropping it.',
      'Note (agent): Blocked on which option to carry out.',
      'Reply (human): Carry out option B.',
    ]);
  });

  it('prints every note of an account that runs to several', () => {
    const finding = load('ruled-history');
    const { opening, answer } = exchange(finding);
    const brief = formatBrief({
      ...finding,
      progress: {
        ...finding.progress,
        notes: [
          { ...opening, text: 'Reproduced with a zero-cost response.' },
          { ...opening, text: 'Blocked on which option to carry out.' },
          { ...answer, text: 'Ship the flag first.' },
        ],
      },
    });
    expect(noteLinesOf(brief)).toEqual([
      'Note (agent): Reproduced with a zero-cost response.',
      'Note (agent): Blocked on which option to carry out.',
      'Reply (human): Ship the flag first.',
    ]);
  });

  it('prints one note when nobody has replied', () => {
    const finding = load('ruled-history');
    const brief = formatBrief({
      ...finding,
      progress: { ...finding.progress, notes: finding.progress.notes.slice(0, 1) },
    });
    expect(brief).toContain('Note (agent): Reproduced with a zero-cost response.');
    expect(brief).not.toContain('Reply (');
  });

  it('calls the human note a note when no agent ever wrote', () => {
    const finding = load('ruled-history');
    const brief = formatBrief({
      ...finding,
      progress: { ...finding.progress, notes: finding.progress.notes.slice(1) },
    });
    expect(brief).toContain('Note (human): Ship the flag first.');
    expect(brief).not.toContain('Reply (');
  });

  it('reports a finding nobody has started as not started', () => {
    const brief = formatBrief(load('question-open'));
    expect(brief).toContain('Progress: not-started');
    expect(brief).not.toContain('Note (');
    expect(brief).not.toContain('Reply (');
  });

  it('carries the explainer', () => {
    expect(formatBrief(load('no-options'))).toContain('Both `notifications` and `identity` write');
  });

  it('names the group the finding declares', () => {
    expect(formatBrief(load('open-two-options'))).toContain('Group: connection-lifecycle');
  });

  it('lists the findings this one declares itself related to', () => {
    expect(formatBrief(load('open-two-options'))).toContain('Related: AI-5, AI-9');
  });

  it('leaves both lines out when the finding declares neither', () => {
    const brief = formatBrief(load('ruled-history'));
    expect(brief).not.toContain('Group:');
    expect(brief).not.toContain('Related:');
  });
});

describe('dedication in both briefs', () => {
  it.each([
    ['formatBrief', formatBrief],
    ['formatContestBrief', formatContestBrief],
  ])('%s says the finding is dedicated', (_label, format) => {
    expect(format(load('dedicated'))).toContain(
      'Dedicated: this finding takes a session of its own, not an ordinary task.'
    );
  });

  it.each([
    ['formatBrief', formatBrief],
    ['formatContestBrief', formatContestBrief],
  ])('%s says nothing about dedication on an ordinary finding', (_label, format) => {
    expect(format(load('open-two-options'))).not.toContain('Dedicated:');
  });

  it.each([
    ['formatBrief', formatBrief],
    ['formatContestBrief', formatContestBrief],
  ])('%s marks the option that would make the finding dedicated', (_label, format) => {
    const brief = format(load('dedicated-option'));
    expect(brief).toContain('Choosing this option makes the finding dedicated.');
    expect(brief.split('Choosing this option makes the finding dedicated.')).toHaveLength(2);
  });
});

describe('questions in both briefs', () => {
  it.each([
    ['formatBrief', formatBrief],
    ['formatContestBrief', formatContestBrief],
  ])('%s carries the answer to an answered question', (_label, format) => {
    const finding = load('ruled-history');
    const settled = answered(finding);
    expect(format(finding)).toContain(`Answer, at ${settled.at}: ${settled.answer}`);
  });
});

describe('formatContestBrief', () => {
  it('carries every option, including the ones the ruling passed over', () => {
    const brief = formatContestBrief(load('ruled-history'));
    expect(brief).toContain('Option B: ');
    expect(brief).toContain('Treat zero as authoritative');
  });

  it('marks the option that was ruled', () => {
    expect(formatContestBrief(load('ruled-history'))).toContain(
      'Option B: [ruled] Treat zero as missing and flag the estimate'
    );
  });

  it('leaves the options the ruling passed over unmarked', () => {
    const brief = formatContestBrief(load('ruled-history'));
    const passed = brief.split('\n').filter((line) => line.startsWith('Option A'));
    expect(passed).toHaveLength(1);
    expect(passed[0]).not.toContain('[ruled]');
  });

  it('still opens with the ruling, before the body', () => {
    const brief = formatContestBrief(load('ruled-history'));
    expect(brief.indexOf('Ruling: option B')).toBeLessThan(brief.indexOf('What this is.'));
  });

  it('marks nothing on a finding nobody has ruled', () => {
    expect(formatContestBrief(load('open-two-options'))).not.toContain('[ruled]');
  });

  it('carries the group and the related findings too', () => {
    const brief = formatContestBrief(load('open-two-options'));
    expect(brief).toContain('Group: connection-lifecycle');
    expect(brief).toContain('Related: AI-5, AI-9');
  });

  it('is the brief plus the options it leaves out, and nothing else changed', () => {
    const finding = load('ruled-history');
    const chosen = finding.options.find((option) => option.id === finding.ruling?.option);
    const contested = formatContestBrief({
      ...finding,
      options: chosen === undefined ? [] : [chosen],
    });

    expect(contested).toBe(formatBrief(finding).replace('Option B: ', 'Option B: [ruled] '));
  });
});

describe('formatQuestionsBrief', () => {
  const ASKED = {
    id: 'AI-1',
    title: 'The connection is torn down mid-flight',
    questions: [
      { at: '2026-07-30', text: 'Which slice owns it?', answer: null, answered_at: null },
    ],
  };

  it('is nothing at all when no question is outstanding', () => {
    expect(formatQuestionsBrief([{ ...ASKED, questions: [] }])).toBeNull();
  });

  it('sections each finding under its own title', () => {
    expect(formatQuestionsBrief([ASKED])).toContain('## The connection is torn down mid-flight');
  });

  it('names the finding the questions belong to', () => {
    expect(formatQuestionsBrief([ASKED])).toContain('AI-1');
  });

  it('prints the command that answers each question, with its id and index', () => {
    expect(formatQuestionsBrief([ASKED])).toContain(
      'pnpm docket --answer AI-1 "<answer>" --index 0'
    );
  });

  it('indexes a question by its position in the finding, not among the outstanding ones', () => {
    const finding = {
      ...ASKED,
      questions: [
        { at: '2026-07-30', text: 'Settled already?', answer: 'Yes.', answered_at: '2026-07-31' },
        ...ASKED.questions,
      ],
    };

    const brief = formatQuestionsBrief([finding]);
    expect(brief).toContain('--index 1');
    expect(brief).not.toContain('Settled already?');
  });

  it('covers every finding that still owes an answer in the one document', () => {
    const other = {
      id: 'DB-3',
      title: 'The migration chain drops live tables',
      questions: [{ at: '2026-07-30', text: 'Has it run?', answer: null, answered_at: null }],
    };

    const brief = formatQuestionsBrief([ASKED, other]);
    expect(brief).toContain('Which slice owns it?');
    expect(brief).toContain('Has it run?');
    expect(brief).toContain('pnpm docket --answer DB-3 "<answer>" --index 0');
  });

  it('leaves out a finding whose questions are all answered', () => {
    const settled = {
      id: 'DB-3',
      title: 'The migration chain drops live tables',
      questions: [
        { at: '2026-07-30', text: 'Has it run?', answer: 'Yes.', answered_at: '2026-08' },
      ],
    };

    expect(formatQuestionsBrief([ASKED, settled])).not.toContain('DB-3');
  });
});

describe('formatBrief, sparse findings', () => {
  it('shows a ruling that carries neither text nor note', () => {
    const finding = load('ruled-history');
    const brief = formatBrief({
      ...finding,
      ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
    });
    expect(brief).toContain('Ruling: option A');
    expect(brief).not.toContain('Note:');
  });

  it('shows a denial that carries no reason', () => {
    const finding = load('denied');
    const brief = formatBrief({
      ...finding,
      denial: { by: 'audit', reason: null, at: '2026-07-30' },
    });
    expect(brief).toContain('Denied by audit');
  });

  it('shows an option that carries neither meta nor prose', () => {
    const finding = load('open-two-options');
    const brief = formatBrief({
      ...finding,
      options: [
        { id: 'A', label: 'Bare', recommended: false, dedicated: false, meta: null, body: '' },
      ],
    });
    expect(brief).toContain('Option A: Bare');
  });

  it('marks a finding the human has verified', () => {
    const finding = load('ruled-history');
    expect(
      formatBrief({ ...finding, progress: { ...finding.progress, verified: true } })
    ).toContain('Progress: in-progress, verified');
  });
});
