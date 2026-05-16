import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PageBody } from './page-body';

describe('PageBody', () => {
  it('wraps children in an outer scroll container and an inner width-constrained wrapper', () => {
    render(
      <PageBody>
        <span>content</span>
      </PageBody>
    );

    const outer = screen.getByTestId('page-body');
    // Outer div: full-width scroll container. Wheel/touch scroll lands here
    // anywhere in the body area, including outside the centered content.
    expect(outer.className).toContain('overflow-y-auto');
    expect(outer.className).toContain('flex-1');
    expect(outer.className).toContain('min-h-0');

    // Inner div: width-constrained content wrapper.
    const inner = outer.firstElementChild;
    expect(inner?.className).toContain('mx-auto');
    expect(inner?.className).toContain('max-w-4xl');
    expect(inner?.className).toContain('p-4');
    expect(inner?.textContent).toBe('content');
  });

  it('does NOT put overflow-y-auto on the width-constrained inner div', () => {
    // Regression: combining max-w-4xl and overflow-y-auto on a single div is
    // exactly the bug this component exists to prevent.
    render(<PageBody>content</PageBody>);
    const inner = screen.getByTestId('page-body').firstElementChild;
    expect(inner?.className).not.toContain('overflow-y-auto');
  });

  it('appends extra classes to the inner content wrapper (e.g. space-y-6)', () => {
    render(<PageBody className="custom-x space-y-6">content</PageBody>);
    const inner = screen.getByTestId('page-body').firstElementChild;
    expect(inner?.className).toContain('space-y-6');
    expect(inner?.className).toContain('custom-x');
  });

  it('leaves outer container untouched when className is passed (extra classes go on inner)', () => {
    render(<PageBody className="space-y-6">content</PageBody>);
    const outer = screen.getByTestId('page-body');
    expect(outer.className).not.toContain('space-y-6');
  });

  it('uses a caller-provided testId on the outer container when passed', () => {
    render(<PageBody testId="usage-content">content</PageBody>);
    const outer = screen.getByTestId('usage-content');
    expect(outer.className).toContain('overflow-y-auto');
    // Default 'page-body' testid is replaced, not coexistent.
    expect(screen.queryByTestId('page-body')).toBeNull();
  });
});
