import { describe, it, expect, vi } from 'vitest';
import { makeFinding, makeQuestion } from '@/test-utils/finding-fixture';
import { SECTIONS } from '@/components/shell/logic/sections';
import { jumpPatch, jumpTo, landTo, landingPatch } from './jump';
import type { FindingState } from '@hushbox/docket';

const corpus = [
  makeFinding({ id: 'A-1', state: 'open' }),
  makeFinding({ id: 'A-2', state: 'open', questions: [makeQuestion()] }),
  makeFinding({ id: 'A-3', state: 'ruled' }),
  makeFinding({ id: 'A-4', state: 'denied' }),
];

describe('jumpPatch', () => {
  it('lands on the section that holds an open finding', () => {
    expect(jumpPatch(corpus, 'A-1')).toEqual({ section: 'open', focus: 'A-1' });
  });

  it('lands on Questions for a questioned finding, which Open no longer holds', () => {
    expect(jumpPatch(corpus, 'A-2')).toEqual({ section: 'questions', focus: 'A-2' });
  });

  it('lands on Ruled for a ruled finding rather than Progress', () => {
    expect(jumpPatch(corpus, 'A-3')).toEqual({ section: 'ruled', focus: 'A-3' });
  });

  it('lands on Progress for a finding whose work is done, which no queue offers', () => {
    const finished = makeFinding({
      id: 'A-6',
      state: 'ruled',
      progress: { status: 'done', updated: '2026-08-01', verified: false, notes: [] },
    });

    expect(jumpPatch([finished], 'A-6')).toEqual({ section: 'progress', focus: 'A-6' });
  });

  it('lands on Denied for a denied finding', () => {
    expect(jumpPatch(corpus, 'A-4')).toEqual({ section: 'denied', focus: 'A-4' });
  });

  it('never lands on a whole-audit section, whose state is not a queue it reads', () => {
    const wholeAudit = SECTIONS.filter((section) => section.wholeAudit).map(
      (section) => section.id
    );
    const landings = corpus.map((finding) => jumpPatch(corpus, finding.id)?.section);

    expect(wholeAudit.length).toBeGreaterThan(0);
    expect(landings.some((section) => wholeAudit.includes(section!))).toBe(false);
  });

  it('refuses an id the audit does not hold', () => {
    expect(jumpPatch(corpus, 'nope')).toBeNull();
  });

  it('refuses a state no section is a view of', () => {
    // A state added to the format before a section exists for it must not send
    // the reader to a pane that cannot show it.
    const orphan = makeFinding({ id: 'A-5', state: 'archived' as FindingState });
    expect(jumpPatch([orphan], 'A-5')).toBeNull();
  });
});

describe('jumpTo', () => {
  it('goes where the finding lives', () => {
    const go = vi.fn();

    jumpTo(corpus, 'A-3', go);

    expect(go).toHaveBeenCalledWith({ section: 'ruled', focus: 'A-3' });
  });

  it('goes nowhere for an id with nowhere to go', () => {
    const go = vi.fn();

    jumpTo(corpus, 'nope', go);

    expect(go).not.toHaveBeenCalled();
  });
});

describe('landingPatch', () => {
  it('reads the destination off the finding it is handed, not off any list', () => {
    // The finding the caller holds says `ruled` while the list still says
    // `open`: the finding wins, which is what makes the answer snapshot-free.
    const stale = [makeFinding({ id: 'A-1', state: 'open' })];
    const restored = makeFinding({ id: 'A-1', state: 'ruled' });

    expect(landingPatch(restored)).toEqual({ section: 'ruled', focus: 'A-1' });
    expect(jumpPatch(stale, 'A-1')).toEqual({ section: 'open', focus: 'A-1' });
  });

  it('sends a questioned finding to Questions', () => {
    expect(
      landingPatch(makeFinding({ id: 'A-2', state: 'open', questions: [makeQuestion()] }))
    ).toEqual({
      section: 'questions',
      focus: 'A-2',
    });
  });

  it('has nowhere to land a state no queue section is a view of', () => {
    const orphan = makeFinding({ id: 'A-9', state: 'archived' as FindingState });
    expect(landingPatch(orphan)).toBeNull();
  });
});

describe('landTo', () => {
  it('lands where the finding says it belongs', () => {
    const go = vi.fn();

    landTo(makeFinding({ id: 'A-3', state: 'denied' }), go);

    expect(go).toHaveBeenCalledWith({ section: 'denied', focus: 'A-3' });
  });

  it('goes nowhere when the finding has nowhere to land', () => {
    const go = vi.fn();

    landTo(makeFinding({ id: 'A-9', state: 'archived' as FindingState }), go);

    expect(go).not.toHaveBeenCalled();
  });
});
