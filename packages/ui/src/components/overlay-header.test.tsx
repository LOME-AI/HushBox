import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OverlayHeader } from './overlay-header';

describe('OverlayHeader', () => {
  it('renders title as h2', () => {
    render(<OverlayHeader title="My Title" />);

    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('My Title');
  });

  it('title has correct styling', () => {
    render(<OverlayHeader title="Styled Title" />);

    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.className).toMatch(/text-lg/);
    expect(heading.className).toMatch(/font-semibold/);
  });

  it('renders description when provided', () => {
    render(<OverlayHeader title="Title" description="Some description" />);

    expect(screen.getByText('Some description')).toBeInTheDocument();
  });

  it('description has correct styling', () => {
    render(<OverlayHeader title="Title" description="Desc" />);

    const desc = screen.getByText('Desc');
    expect(desc.tagName).toBe('P');
    expect(desc.className).toMatch(/text-muted-foreground/);
    expect(desc.className).toMatch(/text-sm/);
    expect(desc.className).toMatch(/mt-1/);
  });

  it('does not render description element when not provided', () => {
    const { container } = render(<OverlayHeader title="Title Only" />);

    expect(container.querySelector('p')).toBeNull();
  });

  it('accepts ReactNode description', () => {
    render(
      <OverlayHeader
        title="Title"
        description={
          <>
            Delete <strong>important</strong> item
          </>
        }
      />
    );

    expect(screen.getByText('important')).toBeInTheDocument();
  });

  it('merges className on wrapper', () => {
    const { container } = render(<OverlayHeader title="Title" className="text-center" />);

    expect(container.firstElementChild?.className).toMatch(/text-center/);
  });
});
