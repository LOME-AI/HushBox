import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { renderWithProviders } from '@/test-utils/render';
import { PageHeader } from './page-header';
import { PageShell } from './page-shell';

const { navigateSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn() }));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

function slot(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-page-slot="${name}"]`);
  if (element === null) throw new Error(`no ${name} slot`);
  return element;
}

function header(): HTMLElement {
  const element = document.querySelector('header');
  if (element === null) throw new Error('no header');
  return element;
}

function renderInShell(page: React.ReactElement): void {
  renderWithProviders(<PageShell>{page}</PageShell>);
}

describe('PageHeader', () => {
  beforeEach(() => {
    navigateSpy.mockClear();
  });

  describe('title', () => {
    it('renders the title as the page h1', () => {
      renderInShell(<PageHeader title="Settings" />);

      expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    });

    it('writes the title into the shell title slot', () => {
      renderInShell(<PageHeader title="Settings" />);

      expect(slot('title')).toContainElement(screen.getByRole('heading', { level: 1 }));
    });

    it('draws the title in Signal Red, the heading default', () => {
      renderInShell(<PageHeader title="Settings" />);

      expect(screen.getByRole('heading', { level: 1 })).not.toHaveClass('text-foreground');
    });

    it('sets the title in the header title role', () => {
      renderInShell(<PageHeader title="Settings" />);

      expect(screen.getByRole('heading', { level: 1 })).toHaveClass(
        'text-header-title',
        'font-sans'
      );
    });

    it('truncates the title rather than wrapping it', () => {
      renderInShell(<PageHeader title="A very long conversation title" />);

      expect(screen.getByRole('heading', { level: 1 })).toHaveClass('truncate');
    });

    it('lets the title shrink below its text width', () => {
      renderInShell(<PageHeader title="A very long conversation title" />);

      expect(screen.getByTestId('page-header-title')).toHaveClass('min-w-0');
    });

    it('reaches into no element it does not draw', () => {
      renderInShell(<PageHeader title="Settings" />);

      expect(screen.getByTestId('page-header-title').className).not.toMatch(/(^|\s)\*:/);
    });

    it('keeps the full title reachable when it truncates', () => {
      renderInShell(<PageHeader title="A very long conversation title" />);

      expect(screen.getByTestId('page-header-title')).toHaveAttribute(
        'title',
        'A very long conversation title'
      );
    });

    it('shows the title at every width', () => {
      renderInShell(<PageHeader title="Settings" />);

      const title = screen.getByTestId('page-header-title');
      expect(title.className).not.toMatch(/(^|\s)(hidden|max-md:hidden|md:hidden)(\s|$)/);
      expect(screen.getByRole('heading', { level: 1 }).className).not.toMatch(
        /(^|\s)(hidden|md:block)(\s|$)/
      );
    });

    it('takes the test id the page gives its title', () => {
      renderInShell(<PageHeader title="Lisbon trip" titleTestId={TEST_IDS.chatTitle} />);

      expect(screen.getByTestId(TEST_IDS.chatTitle)).toHaveTextContent('Lisbon trip');
    });

    it('draws no heading without a title', () => {
      renderInShell(<PageHeader />);

      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    });

    // A conversation whose title decrypts to nothing must not leave a nameless h1 for
    // the route announcer to focus.
    it('draws no heading for an empty title', () => {
      renderInShell(<PageHeader title="" />);

      expect(document.querySelector('h1')).toBeNull();
    });
  });

  describe('slots', () => {
    it('writes the centre into the centre slot', () => {
      renderInShell(<PageHeader center={<span>picker</span>} />);

      expect(within(slot('center')).getByText('picker')).toBeInTheDocument();
    });

    it('writes the shield into the shield slot', () => {
      renderInShell(<PageHeader shield={<span>shield</span>} />);

      expect(within(slot('shield')).getByText('shield')).toBeInTheDocument();
    });

    it('writes the facepile into the facepile slot', () => {
      renderInShell(<PageHeader facepile={<span>faces</span>} />);

      expect(within(slot('facepile')).getByText('faces')).toBeInTheDocument();
    });

    it('writes the strip into the strip slot', () => {
      renderInShell(<PageHeader strip={<span>members</span>} />);

      expect(within(slot('strip')).getByText('members')).toBeInTheDocument();
    });

    it('keeps context from where the page renders it', () => {
      const PageContext = React.createContext('shell');
      function Reader(): React.JSX.Element {
        return <span>{React.useContext(PageContext)}</span>;
      }
      renderInShell(
        <PageContext value="page">
          <PageHeader center={<Reader />} />
        </PageContext>
      );

      expect(within(slot('center')).getByText('page')).toBeInTheDocument();
    });

    it('empties its slots when the page unmounts', () => {
      const { rerender } = renderWithProviders(
        <PageShell>
          <PageHeader title="Settings" shield={<span>shield</span>} />
        </PageShell>
      );

      rerender(<PageShell>{null}</PageShell>);

      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
      expect(slot('shield')).toBeEmptyDOMElement();
    });
  });

  describe('New chat', () => {
    it('draws no New chat icon unless the page asks for one', () => {
      renderInShell(<PageHeader />);

      expect(screen.queryByTestId(TEST_IDS.headerNewChat)).not.toBeInTheDocument();
    });

    it('draws the New chat icon in its slot', () => {
      renderInShell(<PageHeader showNewChat />);

      expect(slot('new-chat')).toContainElement(screen.getByTestId(TEST_IDS.headerNewChat));
    });

    it('names the New chat icon', () => {
      renderInShell(<PageHeader showNewChat />);

      expect(screen.getByRole('button', { name: 'New Chat' })).toBeInTheDocument();
    });

    it('starts a new chat', async () => {
      const user = userEvent.setup();
      renderInShell(<PageHeader showNewChat />);

      await user.click(screen.getByRole('button', { name: 'New Chat' }));

      expect(navigateSpy).toHaveBeenCalledWith({ to: ROUTES.CHAT });
    });
  });

  describe('header test id', () => {
    it('gives the shell header the test id the page names', () => {
      renderInShell(<PageHeader testId={TEST_IDS.chatHeader} />);

      expect(header()).toHaveAttribute('data-testid', TEST_IDS.chatHeader);
    });

    it('gives the shell header back its own test id when the page unmounts', () => {
      const { rerender } = renderWithProviders(
        <PageShell>
          <PageHeader testId={TEST_IDS.chatHeader} />
        </PageShell>
      );

      rerender(<PageShell>{null}</PageShell>);

      expect(header()).toHaveAttribute('data-testid', 'page-header');
    });
  });

  it('renders nothing outside a page shell', () => {
    const { container } = render(<PageHeader title="Settings" showNewChat />);

    expect(container).toBeEmptyDOMElement();
  });
});
