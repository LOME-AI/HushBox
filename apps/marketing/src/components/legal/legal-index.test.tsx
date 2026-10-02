import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { LegalIndex } from './LegalIndex';

const SECTIONS = [
  { id: 'data-collection', title: 'Data Collection' },
  { id: 'your-rights', title: 'Your Rights' },
] as const;

function noop(): void {
  // The control's handler is not under test here.
}

function indexNav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'On this page' });
}

describe('LegalIndex', () => {
  it('links every section to its anchor', () => {
    render(<LegalIndex sections={SECTIONS} allOpen={false} onToggleAll={noop} hydrated />);
    const links = within(indexNav()).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Data Collection', '#data-collection'],
      ['Your Rights', '#your-rights'],
    ]);
  });

  it('numbers the entries from 01 in list order', () => {
    render(<LegalIndex sections={SECTIONS} allOpen={false} onToggleAll={noop} hydrated />);
    const items = within(indexNav()).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['01Data Collection', '02Your Rights']);
  });

  it('heads the open index with "On this page"', () => {
    render(<LegalIndex sections={SECTIONS} allOpen={false} onToggleAll={noop} hydrated />);
    expect(within(indexNav()).getByRole('heading', { name: 'On this page' })).toBeInTheDocument();
  });

  it('offers the same list in a disclosure that starts closed', () => {
    const { container } = render(
      <LegalIndex sections={SECTIONS} allOpen={false} onToggleAll={noop} hydrated />
    );
    const disclosure = container.querySelector('details');
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute('open');
    expect(disclosure?.querySelector('summary')?.textContent).toBe('On this page');
    expect(disclosure?.querySelectorAll('a[href^="#"]')).toHaveLength(SECTIONS.length);
  });

  it('reads "Show all details" while any section is closed', () => {
    render(<LegalIndex sections={SECTIONS} allOpen={false} onToggleAll={noop} hydrated />);
    const control = within(indexNav()).getByRole('button');
    expect(control).toHaveTextContent('Show all details');
    expect(control).toHaveAttribute('aria-expanded', 'false');
  });

  it('reads "Hide all details" when every section is open', () => {
    render(<LegalIndex sections={SECTIONS} allOpen onToggleAll={noop} hydrated />);
    const control = within(indexNav()).getByRole('button');
    expect(control).toHaveTextContent('Hide all details');
    expect(control).toHaveAttribute('aria-expanded', 'true');
  });

  it('marks the show control with chevrons pointing down', () => {
    render(<LegalIndex sections={SECTIONS} allOpen={false} onToggleAll={noop} hydrated />);
    const control = within(indexNav()).getByRole('button');
    expect(control.querySelector('svg')).toHaveClass('lucide-chevrons-down');
  });

  it('marks the hide control with chevrons pointing up', () => {
    render(<LegalIndex sections={SECTIONS} allOpen onToggleAll={noop} hydrated />);
    const control = within(indexNav()).getByRole('button');
    expect(control.querySelector('svg')).toHaveClass('lucide-chevrons-up');
  });

  it('asks for every section to toggle when the control is pressed', async () => {
    const onToggleAll = vi.fn<() => void>();
    render(<LegalIndex sections={SECTIONS} allOpen={false} onToggleAll={onToggleAll} hydrated />);
    await userEvent.click(within(indexNav()).getByRole('button'));
    expect(onToggleAll).toHaveBeenCalledOnce();
  });

  it('keeps every control disabled until the island has hydrated', () => {
    render(<LegalIndex sections={SECTIONS} allOpen={false} onToggleAll={noop} hydrated={false} />);
    const controls = screen.getAllByRole('button', { name: 'Show all details' });
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control).toBeDisabled();
    }
  });

  it('gives the phone layout its own control driving the same toggle', async () => {
    const onToggleAll = vi.fn<() => void>();
    render(<LegalIndex sections={SECTIONS} allOpen={false} onToggleAll={onToggleAll} hydrated />);
    const outside = screen
      .getAllByRole('button', { name: 'Show all details' })
      .filter((control) => !indexNav().contains(control));
    expect(outside).toHaveLength(1);
    for (const control of outside) {
      await userEvent.click(control);
    }
    expect(onToggleAll).toHaveBeenCalledOnce();
  });

  it('reaches the touch floor on every control under a coarse pointer, keeping its drawn size', () => {
    render(<LegalIndex sections={SECTIONS} allOpen={false} onToggleAll={noop} hydrated />);
    for (const control of screen.getAllByRole('button', { name: 'Show all details' })) {
      expect(control).toHaveClass(
        'relative',
        'pointer-coarse:before:absolute',
        'pointer-coarse:before:h-11',
        'pointer-coarse:before:top-1/2',
        'pointer-coarse:before:-translate-y-1/2'
      );
    }
  });

  it('reaches the touch floor on the phone disclosure without reaching its first link', () => {
    const { container } = render(
      <LegalIndex sections={SECTIONS} allOpen={false} onToggleAll={noop} hydrated />
    );
    expect(container.querySelector('details > summary')).toHaveClass(
      'relative',
      'pointer-coarse:before:absolute',
      'pointer-coarse:before:-top-3.5',
      'pointer-coarse:before:-bottom-2.5'
    );
  });
});
