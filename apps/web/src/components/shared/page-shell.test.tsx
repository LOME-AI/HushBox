import { describe, it, expect, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { renderWithProviders } from '@/test-utils/render';
import { useUIStore } from '@/stores/ui/ui';
import { PageShell } from './page-shell';

function header(): HTMLElement {
  const element = document.querySelector('header');
  if (element === null) throw new Error('no header');
  return element;
}

function slot(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-page-slot="${name}"]`);
  if (element === null) throw new Error(`no ${name} slot`);
  return element;
}

describe('PageShell', () => {
  beforeEach(() => {
    useUIStore.setState({ mobileSidebarOpen: false });
  });

  it('draws one header row', () => {
    renderWithProviders(<PageShell>page</PageShell>);

    expect(document.querySelectorAll('header')).toHaveLength(1);
  });

  it('marks the header as chrome', () => {
    renderWithProviders(<PageShell>page</PageShell>);

    expect(header()).toHaveAttribute('data-chrome', '');
  });

  it('holds the header at the app header height', () => {
    renderWithProviders(<PageShell>page</PageShell>);

    expect(header()).toHaveClass('min-h-[var(--app-header-height)]');
  });

  it('wraps the header onto a second row rather than overlapping its controls', () => {
    renderWithProviders(<PageShell>page</PageShell>);

    expect(header()).toHaveClass('flex-wrap');
  });

  it('names the header as the container its New chat key measures', () => {
    renderWithProviders(<PageShell>page</PageShell>);

    expect(header()).toHaveClass('@container/app-header');
  });

  it('gives the header the page header test id when no page names one', () => {
    renderWithProviders(<PageShell>page</PageShell>);

    expect(header()).toHaveAttribute('data-testid', 'page-header');
  });

  it('renders the page inside the page region, below the header', () => {
    renderWithProviders(
      <PageShell>
        <p>page content</p>
      </PageShell>
    );

    const region = slot('region');
    expect(region).toContainElement(screen.getByText('page content'));
    expect(header().compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('lets the page region fill the height below the header', () => {
    renderWithProviders(<PageShell>page</PageShell>);

    expect(slot('region')).toHaveClass('flex', 'min-h-0', 'flex-1', 'flex-col');
  });

  describe('menu button', () => {
    it('draws the menu button in the header', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      expect(within(header()).getByTestId(TEST_IDS.hamburgerButton)).toBeInTheDocument();
    });

    it('leaves the menu button out when the page has no drawer to open', () => {
      renderWithProviders(<PageShell menuButton={false}>page</PageShell>);

      expect(screen.queryByTestId(TEST_IDS.hamburgerButton)).not.toBeInTheDocument();
    });

    it('opens the drawer', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PageShell>page</PageShell>);

      await user.click(screen.getByTestId(TEST_IDS.hamburgerButton));

      expect(useUIStore.getState().mobileSidebarOpen).toBe(true);
    });
  });

  describe('theme toggle', () => {
    it('draws the theme toggle in the header', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      expect(within(header()).getByTestId(TEST_IDS.themeToggle)).toBeInTheDocument();
    });

    it('draws the toggle after the shield slot', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      const toggle = screen.getByTestId(TEST_IDS.themeToggle);
      expect(
        slot('shield').compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING
      ).not.toBe(0);
    });

    it('draws the toggle before the facepile slot', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      const toggle = screen.getByTestId(TEST_IDS.themeToggle);
      expect(
        toggle.compareDocumentPosition(slot('facepile')) & Node.DOCUMENT_POSITION_FOLLOWING
      ).not.toBe(0);
    });
  });

  describe('More options', () => {
    function moreOptions(): HTMLElement {
      return within(header()).getByRole('button', { name: 'More options' });
    }

    it('draws More options in the header', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      expect(moreOptions()).toBeInTheDocument();
    });

    it('ends the header on More options', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      expect(within(header()).getAllByRole('button').at(-1)).toBe(moreOptions());
    });

    it('draws More options after the New chat slot', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      expect(
        slot('new-chat').compareDocumentPosition(moreOptions()) & Node.DOCUMENT_POSITION_FOLLOWING
      ).not.toBe(0);
    });

    it('draws More options on a page with no drawer to open', () => {
      renderWithProviders(<PageShell menuButton={false}>page</PageShell>);

      expect(moreOptions()).toBeInTheDocument();
    });
  });

  describe('slots per band', () => {
    it('places the title, centre, shield, facepile and New chat slots in the header', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      for (const name of ['title', 'center', 'shield', 'facepile', 'new-chat']) {
        expect(header()).toContainElement(slot(name));
      }
    });

    it('lets the title slot take the free width and truncate', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      expect(slot('title')).toHaveClass('min-w-0', 'flex-1');
    });

    it('sets a filled centre right after the title instead of centring it', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      const filled = 'group-has-[[data-page-slot=center]:not(:empty)]/app-header';
      expect(slot('title')).toHaveClass(`${filled}:max-w-max`);
      expect(slot('center')).not.toHaveClass('justify-center');
      expect(slot('shield').parentElement).toHaveClass(`${filled}:ms-auto`);
    });

    // Until the strip carries the members below 768, the facepile is the phone's
    // way to the member list.
    it('shows the facepile slot at every width', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      const hidingClasses = slot('facepile')
        .className.split(/\s+/)
        .filter((name) => name.endsWith('hidden') && name !== 'empty:hidden');
      expect(hidingClasses).toEqual([]);
    });

    it('shows the New chat slot only below 768', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      expect(slot('new-chat')).toHaveClass('md:hidden');
    });

    it('hides the New chat slot while the header is narrower than its key', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      expect(slot('new-chat')).toHaveClass('@max-header-new-chat/app-header:hidden');
    });

    it('places the strip slot between the header and the page region', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      const strip = slot('strip');
      expect(header()).not.toContainElement(strip);
      expect(header().compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
        0
      );
      expect(
        strip.compareDocumentPosition(slot('region')) & Node.DOCUMENT_POSITION_FOLLOWING
      ).not.toBe(0);
    });

    it('hides the strip slot from 768', () => {
      renderWithProviders(<PageShell>page</PageShell>);

      expect(slot('strip')).toHaveClass('md:hidden');
    });
  });
});
