import { act, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, it, expect } from 'vitest';
import { LegalDocument } from './LegalDocument';
import type { LegalSection, LegalDocumentMeta } from '@hushbox/shared/legal';

const META: LegalDocumentMeta = {
  title: 'Privacy Policy',
  effectiveDate: '2026-01-01',
  contactEmail: 'legal@hushbox.ai',
};

const SECTIONS: LegalSection[] = [
  {
    id: 'data-collection',
    title: 'Data Collection',
    simplyPut: 'We collect very little.',
    points: ['Email', 'Username'],
  },
  {
    id: 'your-rights',
    title: 'Your Rights',
    simplyPut: 'You are in control.',
    points: ['Delete anytime'],
  },
];

function detailsOf(container: HTMLElement): HTMLDetailsElement[] {
  return [...container.querySelectorAll<HTMLDetailsElement>('section details')];
}

function indexControl(): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'On this page' })).getByRole('button');
}

function summaryOf(details: HTMLDetailsElement | undefined): HTMLElement {
  const summary = details?.querySelector('summary');
  if (summary === null || summary === undefined) {
    throw new Error('the section has no summary');
  }
  return summary;
}

function navigateToFragment(fragment: string): void {
  globalThis.history.replaceState(null, '', fragment);
}

describe('LegalDocument', () => {
  afterEach(() => {
    navigateToFragment(globalThis.location.pathname);
  });

  it('renders every section title', () => {
    render(<LegalDocument meta={META} sections={SECTIONS} />);
    expect(screen.getByRole('heading', { name: 'Data Collection' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your Rights' })).toBeInTheDocument();
  });

  it('renders the "Simply Put" summary for each section', () => {
    render(<LegalDocument meta={META} sections={SECTIONS} />);
    expect(screen.getByText('We collect very little.')).toBeInTheDocument();
    expect(screen.getByText('You are in control.')).toBeInTheDocument();
  });

  it('lists every section in the index, linked to its anchor', () => {
    render(<LegalDocument meta={META} sections={SECTIONS} />);
    const links = within(screen.getByRole('navigation', { name: 'On this page' })).getAllByRole(
      'link'
    );
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '#data-collection',
      '#your-rights',
    ]);
  });

  it('gives each section the anchor its index entry links to', () => {
    render(<LegalDocument meta={META} sections={SECTIONS} />);
    expect(screen.getByRole('region', { name: 'Data Collection' })).toHaveAttribute(
      'id',
      'data-collection'
    );
  });

  it('keeps every section detail closed by default', () => {
    const { container } = render(<LegalDocument meta={META} sections={SECTIONS} />);
    const details = detailsOf(container);
    expect(details).toHaveLength(SECTIONS.length);
    for (const section of details) {
      expect(section.open).toBe(false);
    }
    expect(screen.getByText('Delete anytime')).not.toBeVisible();
  });

  it('names each section detail "Full details"', () => {
    const { container } = render(<LegalDocument meta={META} sections={SECTIONS} />);
    expect(detailsOf(container).map((section) => summaryOf(section).textContent)).toEqual([
      'Full details',
      'Full details',
    ]);
  });

  it('lists the section points inside its detail', () => {
    const { container } = render(<LegalDocument meta={META} sections={SECTIONS} />);
    const [first] = detailsOf(container);
    expect(
      within(first ?? container)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['Email', 'Username']);
  });

  it('opens every section detail when the control is pressed', async () => {
    const { container } = render(<LegalDocument meta={META} sections={SECTIONS} />);
    await userEvent.click(indexControl());
    expect(detailsOf(container).map((section) => section.open)).toEqual([true, true]);
  });

  it('reads "Hide all details" once every section is open', async () => {
    render(<LegalDocument meta={META} sections={SECTIONS} />);
    await userEvent.click(indexControl());
    expect(indexControl()).toHaveTextContent('Hide all details');
    expect(indexControl()).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes every section detail when pressed with all open', async () => {
    const { container } = render(<LegalDocument meta={META} sections={SECTIONS} />);
    await userEvent.click(indexControl());
    await userEvent.click(indexControl());
    expect(detailsOf(container).map((section) => section.open)).toEqual([false, false]);
    expect(indexControl()).toHaveTextContent('Show all details');
  });

  it('opens the rest when some sections are already open', async () => {
    const { container } = render(<LegalDocument meta={META} sections={SECTIONS} />);
    await userEvent.click(summaryOf(detailsOf(container)[0]));
    await userEvent.click(indexControl());
    expect(detailsOf(container).map((section) => section.open)).toEqual([true, true]);
  });

  it('derives its label from sections the reader opened one by one', async () => {
    const { container } = render(<LegalDocument meta={META} sections={SECTIONS} />);
    for (const section of detailsOf(container)) {
      await userEvent.click(summaryOf(section));
    }
    expect(indexControl()).toHaveTextContent('Hide all details');
  });

  it('reads "Show all details" again once the reader closes one section by hand', async () => {
    const { container } = render(<LegalDocument meta={META} sections={SECTIONS} />);
    await userEvent.click(indexControl());
    await userEvent.click(summaryOf(detailsOf(container)[1]));
    expect(indexControl()).toHaveTextContent('Show all details');
    expect(detailsOf(container).map((section) => section.open)).toEqual([true, false]);
  });

  it('serves the control disabled until the island hydrates', () => {
    const html = renderToString(<LegalDocument meta={META} sections={SECTIONS} />);
    const served = new DOMParser().parseFromString(html, 'text/html');
    const controls = [...served.querySelectorAll('button')];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control).toBeDisabled();
    }
  });

  it('enables the control once hydrated', () => {
    render(<LegalDocument meta={META} sections={SECTIONS} />);
    expect(indexControl()).toBeEnabled();
  });

  it('serves every section without a reveal animation', () => {
    const { container } = render(<LegalDocument meta={META} sections={SECTIONS} />);
    expect(container.querySelector('[style*="opacity"]')).toBeNull();
  });

  it('renders a mailto contact link from the meta', () => {
    render(<LegalDocument meta={META} sections={SECTIONS} />);
    const link = screen.getByRole('link', { name: 'legal@hushbox.ai' });
    expect(link).toHaveAttribute('href', 'mailto:legal@hushbox.ai');
  });

  it('invokes renderAfterSection for each section id and renders its output', () => {
    render(
      <LegalDocument
        meta={META}
        sections={SECTIONS}
        renderAfterSection={(id): React.ReactNode =>
          id === 'data-collection' ? <p>Extra for {id}</p> : null
        }
      />
    );
    expect(screen.getByText('Extra for data-collection')).toBeInTheDocument();
  });

  it('shows the renderAfterSection output outside the closed detail', () => {
    render(
      <LegalDocument
        meta={META}
        sections={SECTIONS}
        renderAfterSection={(id): React.ReactNode => <p>Extra for {id}</p>}
      />
    );
    expect(screen.getByText('Extra for your-rights')).toBeVisible();
  });

  it('renders without extra content when renderAfterSection is omitted', () => {
    render(<LegalDocument meta={META} sections={SECTIONS} />);
    // The document still renders its sections; the optional slot is simply absent.
    expect(screen.getByRole('heading', { name: 'Data Collection' })).toBeInTheDocument();
  });

  describe('arriving at a section by its fragment', () => {
    it('opens the details of the section the fragment names', () => {
      navigateToFragment('#your-rights');
      const { container } = render(<LegalDocument meta={META} sections={SECTIONS} />);
      expect(detailsOf(container).map((section) => section.open)).toEqual([false, true]);
    });

    it('opens the named section when the fragment changes in place', () => {
      const { container } = render(<LegalDocument meta={META} sections={SECTIONS} />);
      act(() => {
        navigateToFragment('#data-collection');
        globalThis.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      expect(detailsOf(container).map((section) => section.open)).toEqual([true, false]);
    });

    it('keeps a section opened by an earlier fragment open', () => {
      navigateToFragment('#your-rights');
      const { container } = render(<LegalDocument meta={META} sections={SECTIONS} />);
      act(() => {
        navigateToFragment('#data-collection');
        globalThis.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      expect(detailsOf(container).map((section) => section.open)).toEqual([true, true]);
    });

    it('opens nothing for a fragment that names no section', () => {
      navigateToFragment('#nowhere');
      const { container } = render(<LegalDocument meta={META} sections={SECTIONS} />);
      expect(detailsOf(container).map((section) => section.open)).toEqual([false, false]);
    });
  });
});
