import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SECTIONS } from './logic/sections';
import { SectionNav } from './section-nav';

const counts = {
  dashboard: 342,
  open: 331,
  questions: 11,
  blocked: 4,
  ruled: 112,
  dedicated: 0,
  denied: 92,
  progress: 116,
};

describe('SectionNav', () => {
  it('offers every section', () => {
    render(<SectionNav active="open" counts={counts} onSelect={(): void => {}} />);

    for (const section of SECTIONS) {
      expect(screen.getByRole('button', { name: new RegExp(section.label) })).toBeInTheDocument();
    }
  });

  it('carries each section count', () => {
    render(<SectionNav active="open" counts={counts} onSelect={(): void => {}} />);

    expect(screen.getByRole('button', { name: /Open/ })).toHaveTextContent('331');
    expect(screen.getByRole('button', { name: /Questions/ })).toHaveTextContent('11');
    expect(screen.getByRole('button', { name: /Blocked/ })).toHaveTextContent('4');
  });

  it('marks the section being read', () => {
    render(<SectionNav active="denied" counts={counts} onSelect={(): void => {}} />);

    expect(screen.getByRole('button', { name: /Denied/ })).toHaveAttribute('aria-current', 'page');
  });

  it('leaves the other sections unmarked', () => {
    render(<SectionNav active="denied" counts={counts} onSelect={(): void => {}} />);

    expect(screen.getByRole('button', { name: /Open/ })).not.toHaveAttribute('aria-current');
  });

  it('reports the section a reader picks', () => {
    const onSelect = vi.fn();
    render(<SectionNav active="open" counts={counts} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: /Progress/ }));

    expect(onSelect).toHaveBeenCalledWith('progress');
  });

  it('carries its own scroll, so a narrow window cannot put a section out of reach', () => {
    render(<SectionNav active="open" counts={counts} onSelect={(): void => {}} />);

    const nav = screen.getByRole('navigation', { name: 'Sections' });

    expect(nav.className).toContain('overflow-x-auto');
    // Without this a flex item refuses to shrink below its content, so the row
    // overflows the shell instead of scrolling inside it.
    expect(nav.className).toContain('min-w-0');
  });

  it('keeps every tab at its own width rather than squeezing the labels', () => {
    render(<SectionNav active="open" counts={counts} onSelect={(): void => {}} />);

    expect(screen.getByRole('button', { name: /Progress/ }).className).toContain('shrink-0');
  });
});
