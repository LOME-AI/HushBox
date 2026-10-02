import { fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HOUR_MS, isoAt } from '@hushbox/shared/test-time';
import {
  WEEK_START,
  stubFetch,
  renderScreen,
  screenReady,
  panelNamed,
  installGrowthScreenHarness,
} from './test-support/growth-screen-harness.setup.js';
import type { GrowthEventRowWire } from '@hushbox/shared';

vi.mock('@/components/ops/op-modal-provider', () => ({
  useRunOp: () => vi.fn(),
}));

vi.mock('recharts', async (importOriginal) => {
  const { rechartsWithFixedContainer } =
    await import('./test-support/recharts-fixed-container.setup.js');
  return rechartsWithFixedContainer(await importOriginal<typeof import('recharts')>());
});

installGrowthScreenHarness();

describe('GrowthScreen click overlay', () => {
  /** The panel the framed marketing page and its badges are drawn in. */
  const OVERLAY_PANEL = 'Where people clicked';

  /** One element's box, which a layout-free document reports none of. */
  const ELEMENT_BOX = { left: 20, top: 100, width: 200, height: 40 } as DOMRect;

  /** A named-event row on the framed page, as the events read returns one. */
  function welcomeEventRow(eventName: string, visitors: number): GrowthEventRowWire {
    return {
      hour: isoAt(WEEK_START + 10 * HOUR_MS),
      campaign: 'hn-launch',
      eventName,
      path: '/welcome',
      visitors,
      overflow: false,
    };
  }

  /** The frame the overlay draws its badges over. */
  function overlayFrame(): HTMLIFrameElement {
    const frame = within(panelNamed(OVERLAY_PANEL)).getByTitle('Marketing page /welcome');
    if (!(frame instanceof HTMLIFrameElement)) throw new Error('the overlay rendered no frame');
    return frame;
  }

  /** The overlay measuring `html` as the framed page, each element laid out. */
  function framedWith(html: string): void {
    const frame = overlayFrame();
    const frameDocument = frame.contentDocument;
    if (frameDocument === null) throw new Error('the framed document is unreachable');
    frameDocument.body.innerHTML = html;
    const root = frameDocument.documentElement;
    Object.defineProperty(root, 'scrollWidth', { value: 1000, configurable: true });
    Object.defineProperty(root, 'scrollHeight', { value: 2000, configurable: true });
    for (const element of frameDocument.body.querySelectorAll('*')) {
      element.getBoundingClientRect = (): DOMRect => ELEMENT_BOX;
    }
    fireEvent.load(frame);
  }

  /** What the overlay has badged, each badge's own words. */
  function badgeWords(): string[] {
    return [...panelNamed(OVERLAY_PANEL).querySelectorAll('[data-slot="overlay-badge"]')].map(
      (badge) => badge.textContent
    );
  }

  it('frames the site entry page under the prefix the admin origin serves the copy at', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(overlayFrame()).toHaveAttribute('src', '/preview/welcome/');
    });
  });

  it('says the figures were counted from every row where the read answered in one page', async () => {
    stubFetch({ eventRows: [welcomeEventRow('link:/signup', 121)], eventsHaveMore: false });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(
        within(panelNamed(OVERLAY_PANEL)).getByText(
          'The named-events read answered in one page, so these figures were counted from every row it returned.'
        )
      ).toBeInTheDocument();
    });
  });

  it('badges the rows of the page in hand where the read has other pages', async () => {
    stubFetch({
      eventRows: [welcomeEventRow('link:/signup', 121), welcomeEventRow('link:/signup', 79)],
      eventsHaveMore: true,
    });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(overlayFrame()).toBeInTheDocument();
    });
    framedWith('<a href="/signup">Start</a>');
    expect(badgeWords()).toEqual(['link:/signup: 200']);
  });

  it('names the one page its figures came from where the read has other pages', async () => {
    stubFetch({ eventRows: [welcomeEventRow('link:/signup', 121)], eventsHaveMore: true });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(
        within(panelNamed(OVERLAY_PANEL)).getByText(
          'These figures were counted from page 1 of the named-events read alone; whatever it returned on its other pages is in no badge here.'
        )
      ).toBeInTheDocument();
    });
  });

  it('badges an element with the count the read answered with for it', async () => {
    stubFetch({ eventRows: [welcomeEventRow('link:/signup', 121)] });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(overlayFrame()).toBeInTheDocument();
    });
    framedWith('<a href="/signup">Start</a>');
    expect(badgeWords()).toEqual(['link:/signup: 121']);
  });
});
