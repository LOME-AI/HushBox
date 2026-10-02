import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GROWTH_SECTIONS } from './section-rail.js';
import {
  stubFetch,
  renderScreen,
  screenReady,
  installGrowthScreenHarness,
} from './test-support/growth-screen-harness.setup.js';

vi.mock('@/components/ops/op-modal-provider', () => ({
  useRunOp: () => vi.fn(),
}));

vi.mock('recharts', async (importOriginal) => {
  const { rechartsWithFixedContainer } =
    await import('./test-support/recharts-fixed-container.setup.js');
  return rechartsWithFixedContainer(await importOriginal<typeof import('recharts')>());
});

installGrowthScreenHarness();

describe('GrowthScreen sections', () => {
  /** Which question each panel answers, so it is drawn under that heading. */
  const PANEL_SECTIONS: readonly (readonly [string, string])[] = [
    ['This week', 'Conversion'],
    ['Funnel', 'Conversion'],
    ['Cohorts', 'Conversion'],
    ['Visitors', 'Traffic'],
    ['Referrers', 'Traffic'],
    ['Top pages', 'Traffic'],
    ['Landed on, then reached', 'Traffic'],
    ['Where visitors are', 'Traffic'],
    ['Named events', 'Behaviour'],
    ['Where people clicked', 'Behaviour'],
    ['Where people said they heard of us', 'Attribution'],
    ['Campaigns', 'Attribution'],
  ];

  it('groups the panels under the four questions the screen answers', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    for (const [panel, section] of PANEL_SECTIONS) {
      expect(
        within(screen.getByRole('region', { name: section })).getByRole('heading', { name: panel })
      ).toBeInTheDocument();
    }
  });

  it('draws every panel it drew before, and no others', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    // Collected from each frame's own header rather than from the document: a
    // panel's body draws headings of its own, and a document-wide query counts
    // those as panels.
    const titles = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="panel-frame-header"]'),
    ].map((header) => within(header).getByRole('heading').textContent);
    expect(new Set(titles)).toEqual(new Set(PANEL_SECTIONS.map(([panel]) => panel)));
  });

  /** The utility a section holds its room under the pinned header with. */
  const ANCHOR_UTILITY = '[scroll-margin-top:var(--growth-anchor-line,0px)]';

  /**
   * The breakpoint a utility is written behind on an element, as the variant
   * prefix it carries, or the empty string where it is written unconditionally.
   */
  function breakpointOf(element: Element, utility: string): string {
    const written = [...element.classList].find((name) => name.endsWith(utility));
    return written === undefined ? 'no such utility' : written.slice(0, -utility.length);
  }

  it('holds the sections clear of the header at the width the header pins itself', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    const header = screen.getByRole('navigation', { name: 'Growth sections' }).parentElement;
    const pinnedFrom = breakpointOf(header ?? document.body, 'sticky');
    // A header pinned at every width would make this vacuous: there would be no
    // breakpoint below which the room must not be held.
    expect(pinnedFrom).not.toBe('');
    for (const section of GROWTH_SECTIONS) {
      expect(
        breakpointOf(document.querySelector(`#${section.id}`) ?? document.body, ANCHOR_UTILITY)
      ).toBe(pinnedFrom);
    }
  });

  // The rail re-reads the line it publishes whenever its parent changes size,
  // because the pinned header growing is what moves the rail. Moved into any
  // other box, the rail would stop hearing the header grow and the published
  // line would sit under it.
  it('keeps the rail a direct child of the pinned header, the box its line is re-read on', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    const parent = screen.getByRole('navigation', { name: 'Growth sections' }).parentElement;
    expect(
      [...(parent?.classList ?? [])].some((name) => name === 'sticky' || name.endsWith(':sticky'))
    ).toBe(true);
  });

  it('reaches each section by a link the browser follows on its own', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    const rail = screen.getByRole('navigation', { name: 'Growth sections' });
    expect(
      within(rail)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href'))
    ).toEqual(['#conversion', '#traffic', '#behaviour', '#attribution']);
    for (const fragment of ['conversion', 'traffic', 'behaviour', 'attribution']) {
      expect(document.querySelector(`#${fragment}`)).not.toBeNull();
    }
  });
});
