import { describe, expect, it } from 'vitest';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  DAY_STAMP_PATTERN,
  accountAndReplies,
  dayStamp,
  hasOutstandingQuestion,
  outstandingQuestions,
} from './types.ts';
import { DAY_MS } from './durations.ts';
import type { NoteAuthor, ProgressNote, Question } from './types.ts';

/**
 * The most demanding truncation case: one millisecond before the day rolls
 * over, so a `dayStamp` that read the wrong field would name the next day.
 */
const LAST_INSTANT_OF_DAY = new Date(Date.UTC(2026, 7, 16) + DAY_MS - 1);

function question(text: string, answer: string | null): Question {
  return { at: '2026-07-30', text, answer, answered_at: answer === null ? null : '2026-07-31' };
}

function note(by: NoteAuthor, text: string): ProgressNote {
  return { at: '2026-07-30', by, text };
}

describe('outstandingQuestions', () => {
  it('carries the index a write addresses the question by, not the position among outstanding ones', () => {
    const finding = { questions: [question('answered', 'yes'), question('open', null)] };

    expect(outstandingQuestions(finding)).toEqual([{ index: 1, text: 'open' }]);
  });

  it('is empty when every question carries an answer', () => {
    const finding = { questions: [question('answered', 'yes')] };

    expect(outstandingQuestions(finding)).toEqual([]);
  });
});

describe('hasOutstandingQuestion', () => {
  it('holds when there are more questions than answers', () => {
    const finding = { questions: [question('answered', 'yes'), question('open', null)] };

    expect(hasOutstandingQuestion(finding)).toBe(true);
  });

  it('does not hold once every question is answered', () => {
    const finding = { questions: [question('answered', 'yes')] };

    expect(hasOutstandingQuestion(finding)).toBe(false);
  });

  it('does not hold on a finding that was never questioned', () => {
    expect(hasOutstandingQuestion({ questions: [] })).toBe(false);
  });
});

describe('accountAndReplies', () => {
  it('finds neither on a finding nobody has left a note on', () => {
    expect(accountAndReplies([])).toEqual({ account: [], replies: [] });
  });

  it('reads every agent note as the account when nobody has replied', () => {
    const notes = [note('agent', 'started'), note('agent', 'stuck on the migration')];

    expect(accountAndReplies(notes)).toEqual({ account: notes, replies: [] });
  });

  it('reads a note after the agent run as a reply, not as part of the account', () => {
    const account = note('agent', 'stuck on the migration');
    const reply = note('human', 'drop the column');

    expect(accountAndReplies([account, reply])).toEqual({
      account: [account],
      replies: [reply],
    });
  });

  it('keeps the whole trailing run in the account, not only its last note', () => {
    const first = note('agent', 'stuck on the migration');
    const second = note('agent', 'and the fixture is stale too');
    const reply = note('human', 'drop the column');

    expect(accountAndReplies([first, second, reply])).toEqual({
      account: [first, second],
      replies: [reply],
    });
  });

  it('lets a later agent run supersede an earlier exchange entirely', () => {
    const earlier = note('agent', 'stuck on the migration');
    const answered = note('human', 'drop the column');
    const latest = note('agent', 'now stuck on the fixture');

    expect(accountAndReplies([earlier, answered, latest])).toEqual({
      account: [latest],
      replies: [],
    });
  });

  it('reads notes no agent ever wrote as replies to nothing', () => {
    const notes = [note('human', 'any progress?'), note('human', 'still waiting')];

    expect(accountAndReplies(notes)).toEqual({ account: [], replies: notes });
  });
});

describe('dayStamp', () => {
  it('mints the day an instant falls on in UTC', () => {
    expect(dayStamp(LAST_INSTANT_OF_DAY)).toBe('2026-08-16');
  });

  it('mints a value the pattern accepts', () => {
    expect(dayStamp(new Date(TEST_DAY_START))).toMatch(DAY_STAMP_PATTERN);
  });
});

describe('DAY_STAMP_PATTERN', () => {
  it('accepts a day', () => {
    expect(DAY_STAMP_PATTERN.test('2026-08-16')).toBe(true);
  });

  it('rejects a value carrying a time', () => {
    expect(DAY_STAMP_PATTERN.test(LAST_INSTANT_OF_DAY.toISOString())).toBe(false);
  });

  it('rejects a value that only starts with a day', () => {
    expect(DAY_STAMP_PATTERN.test('2026-08-16 ')).toBe(false);
  });
});
