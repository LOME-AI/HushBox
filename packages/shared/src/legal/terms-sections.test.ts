import { describe, it, expect } from 'vitest';
import { RELEASE_STAGE } from '../constants.ts';
import { TERMS_BETA_SECTION, TERMS_SECTIONS, termsSectionsFor } from './terms-sections.ts';
import type { LegalSection } from './types.ts';

function ids(sections: readonly { readonly id: string }[]): string[] {
  return sections.map((s) => s.id);
}

// The founder-approved beta disclosure, pinned whole: each line is a promise or a warning
// the system must keep, so a reworded line is a changed obligation, never a typo fix.
const APPROVED_BETA_SECTION: LegalSection = {
  id: 'beta',
  title: 'Open Beta',
  simplyPut:
    'HushBox works, and it is still changing fast. Here is exactly what that means, and what never changes.',
  points: [
    'HushBox is in open beta. Features will change, move, or go away for good, sometimes without notice.',
    'There will be downtime, planned and unplanned, including while we ship updates.',
    'An update can cut off a reply while it is being written.',
    'You may be signed out after an update, and the app will ask you to refresh or update often.',
    'Expect bugs, including in what the app displays. You can report them with Send feedback in the app.',
    'What never changes, beta or not: we cannot read your messages, and the beta changes nothing in the Privacy Policy.',
    'Your purchased credit is never lost to our mistakes. If a defect or a restore affects your balance, we put it back.',
    'Your rights under consumer protection law still apply. Nothing in this section limits them.',
    'The beta will end. When it ends, this section will be removed from these terms.',
  ],
};

describe('TERMS_BETA_SECTION', () => {
  it('publishes the approved beta section whole', () => {
    expect(TERMS_BETA_SECTION).toEqual(APPROVED_BETA_SECTION);
  });

  it('is published at the legal entry point', async () => {
    const published = await import('@hushbox/shared/legal');

    expect(published.TERMS_BETA_SECTION).toEqual(APPROVED_BETA_SECTION);
  });
});

describe('termsSectionsFor', () => {
  it('places the beta section immediately after the description section under beta', () => {
    const order = ids(termsSectionsFor('beta'));

    expect(order[order.indexOf('description') + 1]).toBe('beta');
  });

  it('publishes the beta section under beta as the exported beta section itself', () => {
    const beta = termsSectionsFor('beta').filter((s) => s.id === 'beta');

    expect(beta).toEqual([TERMS_BETA_SECTION]);
  });

  it('publishes under stable exactly the beta sections with the beta section removed', () => {
    expect(termsSectionsFor('stable')).toEqual(
      termsSectionsFor('beta').filter((s) => s.id !== 'beta')
    );
  });
});

describe('TERMS_SECTIONS', () => {
  it('is the section list for the current release stage', () => {
    expect(TERMS_SECTIONS).toEqual(termsSectionsFor(RELEASE_STAGE));
  });

  it('refuses a write to the published list', () => {
    expect(Object.isFrozen(termsSectionsFor('stable'))).toBe(true);
  });

  it('refuses a write to the beta section', () => {
    expect(Object.isFrozen(TERMS_BETA_SECTION.points)).toBe(true);
  });
});
