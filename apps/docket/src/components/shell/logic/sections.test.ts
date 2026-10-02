import { describe, it, expect } from 'vitest';
import { parseFinding } from '@hushbox/docket';
import { findingFile } from '@/test-utils/audit-fixture';
import { makeFinding, makeQuestion } from '@/test-utils/finding-fixture';
import { SECTIONS, SECTION_IDS, isSectionId, sectionSpec } from './sections';
import type { Finding, FindingJson } from '@hushbox/docket';

function stalled(overrides: Partial<FindingJson> = {}): FindingJson {
  return makeFinding({
    id: 'A-1',
    state: 'ruled',
    progress: { status: 'blocked', updated: '2026-08-01', verified: false, notes: [] },
    ...overrides,
  });
}

function finished(overrides: Partial<FindingJson> = {}): FindingJson {
  return makeFinding({
    id: 'A-1',
    state: 'ruled',
    progress: { status: 'done', updated: '2026-08-01', verified: false, notes: [] },
    ...overrides,
  });
}

describe('sections', () => {
  it('has one spec per section id, in the order the tabs read', () => {
    expect(SECTIONS.map((section) => section.id)).toEqual([...SECTION_IDS]);
  });

  it('offers the dedicated queue ahead of the rulings, after the blocked ones', () => {
    expect([...SECTION_IDS]).toEqual([
      'dashboard',
      'open',
      'questions',
      'blocked',
      'dedicated',
      'ruled',
      'denied',
      'progress',
    ]);
  });

  it('holds a ruled finding whose implementation stopped in Blocked', () => {
    expect(sectionSpec('blocked').holds(stalled())).toBe(true);
  });

  it('leaves a finding nothing stopped on out of Blocked', () => {
    const running = stalled({
      progress: { status: 'in-progress', updated: null, verified: false, notes: [] },
    });

    expect(sectionSpec('blocked').holds(running)).toBe(false);
  });

  it('leaves an undecided finding out of Blocked whatever its progress says', () => {
    expect(sectionSpec('blocked').holds(stalled({ state: 'open' }))).toBe(false);
  });

  it('reads Blocked as a queue of ruled findings rather than the whole audit', () => {
    expect([sectionSpec('blocked').state, sectionSpec('blocked').wholeAudit]).toEqual([
      'ruled',
      false,
    ]);
  });

  it('takes a blocked finding out of Ruled, so a contested ruling stops being handed on', () => {
    expect(sectionSpec('ruled').holds(stalled())).toBe(false);
  });

  it('keeps a ruled finding nothing stopped on in Ruled', () => {
    const running = stalled({
      progress: { status: 'in-progress', updated: null, verified: false, notes: [] },
    });

    expect(sectionSpec('ruled').holds(running)).toBe(true);
  });

  it('keeps a blocked finding on the progress board, where the work is tracked', () => {
    expect(sectionSpec('progress').holds(stalled())).toBe(true);
  });

  it('derives progress from ruled findings', () => {
    expect(sectionSpec('progress').state).toBe('ruled');
  });

  it('routes each of the other sections to its own finding state', () => {
    expect([
      sectionSpec('open').state,
      sectionSpec('ruled').state,
      sectionSpec('denied').state,
    ]).toEqual(['open', 'ruled', 'denied']);
  });

  it('holds a finding in the questions section on an unanswered question, not on a state', () => {
    const asked = makeFinding({ id: 'A-1', state: 'ruled', questions: [makeQuestion()] });

    expect(sectionSpec('questions').holds(asked)).toBe(true);
  });

  it('keeps a ruled finding in Ruled while a question on it is still open', () => {
    const asked = makeFinding({ id: 'A-1', state: 'ruled', questions: [makeQuestion()] });

    expect(sectionSpec('ruled').holds(asked)).toBe(true);
  });

  it('keeps a denied finding in Denied while a question on it is still open', () => {
    const asked = makeFinding({ id: 'A-1', state: 'denied', questions: [makeQuestion()] });

    expect(sectionSpec('denied').holds(asked)).toBe(true);
  });

  it('takes an undecided finding out of Open while a question on it is still open', () => {
    const asked = makeFinding({ id: 'A-1', state: 'open', questions: [makeQuestion()] });

    expect(sectionSpec('open').holds(asked)).toBe(false);
  });

  it('puts a finding back in Open once its questions are all answered', () => {
    const answered = makeFinding({
      id: 'A-1',
      state: 'open',
      questions: [makeQuestion({ answer: 'yes', answered_at: '2026-07-31' })],
    });

    expect(sectionSpec('open').holds(answered)).toBe(true);
    expect(sectionSpec('questions').holds(answered)).toBe(false);
  });

  /**
   * The store's shape, not the console's. Anything reading a section outside a
   * browser holds this one, and it is the whole reason `holds` is typed on the
   * fields it reads rather than on the render shape.
   */
  function stored(status: string): Finding {
    const parsed = parseFinding(
      findingFile('A-1', { state: 'ruled' }).replace(
        'status: "not-started"',
        `status: "${status}"`
      ),
      'A-1.md'
    );
    if (!parsed.ok) throw new Error('the fixture finding no longer parses');
    return parsed.value;
  }

  it('places a finding read from the store, not only one rendered for the console', () => {
    expect(sectionSpec('blocked').holds(stored('blocked'))).toBe(true);
  });

  it('answers the same for a stored finding as for a rendered one', () => {
    expect(sectionSpec('ruled').holds(stored('blocked'))).toBe(false);
    expect(sectionSpec('ruled').holds(stored('in-progress'))).toBe(true);
  });

  it('gives every section its own empty copy', () => {
    const titles = SECTIONS.map((section) => section.emptyTitle);
    expect(new Set(titles).size).toBe(SECTIONS.length);
  });

  describe('dedicated', () => {
    it('holds an undecided finding that has been marked', () => {
      const marked = makeFinding({ id: 'A-1', state: 'open', dedicated: true });

      expect(sectionSpec('dedicated').holds(marked)).toBe(true);
    });

    it('holds a ruled finding that has been marked and is still being worked', () => {
      expect(sectionSpec('dedicated').holds(stalled({ dedicated: true }))).toBe(true);
    });

    it('takes a marked finding out once its work is done', () => {
      expect(sectionSpec('dedicated').holds(finished({ dedicated: true }))).toBe(false);
    });

    it('leaves an unmarked finding out', () => {
      expect(sectionSpec('dedicated').holds(makeFinding({ id: 'A-1' }))).toBe(false);
    });

    it('reads as a queue rather than the whole audit, so --section can name it', () => {
      expect(sectionSpec('dedicated').wholeAudit).toBe(false);
    });

    it('takes a marked finding out of Open', () => {
      const marked = makeFinding({ id: 'A-1', state: 'open', dedicated: true });

      expect(sectionSpec('open').holds(marked)).toBe(false);
    });

    it('takes a marked finding out of Ruled', () => {
      const marked = makeFinding({ id: 'A-1', state: 'ruled', dedicated: true });

      expect(sectionSpec('ruled').holds(marked)).toBe(false);
    });

    it('keeps a marked finding in Blocked, because a block outranks the disposition', () => {
      expect(sectionSpec('blocked').holds(stalled({ dedicated: true }))).toBe(true);
    });

    it('places a marked finding read from the store, not only one rendered', () => {
      const parsed = parseFinding(findingFile('A-1', { dedicated: true }), 'A-1.md');
      if (!parsed.ok) throw new Error('the fixture finding no longer parses');

      expect(sectionSpec('dedicated').holds(parsed.value)).toBe(true);
    });
  });

  describe('finished work', () => {
    it('takes a done finding out of Ruled, so the handoff stops offering it', () => {
      expect(sectionSpec('ruled').holds(finished())).toBe(false);
    });

    it('takes a done finding out of Open', () => {
      expect(sectionSpec('open').holds(finished({ state: 'open' }))).toBe(false);
    });

    it('keeps a done finding on the progress board, which is where it is read', () => {
      expect(sectionSpec('progress').holds(finished())).toBe(true);
    });

    it('keeps a denied finding in Denied whatever its progress says', () => {
      expect(sectionSpec('denied').holds(finished({ state: 'denied' }))).toBe(true);
    });

    it('answers the same for a stored done finding as for a rendered one', () => {
      expect(sectionSpec('ruled').holds(stored('done'))).toBe(false);
      expect(sectionSpec('progress').holds(stored('done'))).toBe(true);
    });
  });

  it('accepts a known section id', () => {
    expect(isSectionId('denied')).toBe(true);
  });

  it('rejects an unknown section id', () => {
    expect(isSectionId('archive')).toBe(false);
  });
});
