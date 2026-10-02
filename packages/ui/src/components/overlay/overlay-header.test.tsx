import { describe, it, expect, vi } from 'vitest';
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

  it('sets the title at a 1.5 line height', () => {
    render(<OverlayHeader title="Styled Title" />);

    expect(screen.getByRole('heading', { level: 2 })).toHaveClass('leading-normal');
  });

  it('sets a large title in the title-1 role', () => {
    render(<OverlayHeader title="Large" size="lg" />);

    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveClass('text-title-1');
    expect(heading).not.toHaveClass('text-lg');
    expect(heading).not.toHaveClass('font-semibold');
  });

  it('renders description when provided', () => {
    render(<OverlayHeader title="Title" description="Some description" />);

    expect(screen.getByText('Some description')).toBeInTheDocument();
  });

  it('description has correct styling', () => {
    render(<OverlayHeader title="Title" description="Desc" />);

    const desc = screen.getByText('Desc');
    expect(desc.tagName).toBe('DIV');
    expect(desc.className).toMatch(/text-muted-foreground/);
    expect(desc.className).toMatch(/text-sm/);
  });

  it('sets the description 0.25rem below the title', () => {
    const { container } = render(<OverlayHeader title="Title" description="Desc" />);

    expect(container.firstElementChild).toHaveClass('flex', 'flex-col', 'gap-1');
  });

  it('pads 0.5rem under a header that has a description, adding to any spacing around it', () => {
    const { container } = render(<OverlayHeader title="Title" description="Desc" />);

    expect(container.firstElementChild).toHaveClass('pb-2');
    expect(container.firstElementChild?.className).not.toMatch(/\bm[by]-/);
  });

  it('adds no extra space under a header without a description', () => {
    const { container } = render(<OverlayHeader title="Title" />);

    expect(container.firstElementChild).not.toHaveClass('pb-2');
  });

  it('gives a header outside an overlay no top padding', () => {
    const { container } = render(<OverlayHeader title="Title" step={{ current: 2, total: 3 }} />);

    expect(container.firstElementChild?.className).not.toMatch(/\bp[ty]-/);
  });

  it('keeps a start-aligned header clear of the close button', () => {
    const { container } = render(<OverlayHeader title="Title" />);

    expect(container.firstElementChild).toHaveClass('pr-6');
  });

  it('centres every block of a centre-aligned header', () => {
    const { container } = render(<OverlayHeader title="Title" align="center" />);

    expect(container.firstElementChild).toHaveClass('items-center', 'text-center', 'px-4');
    expect(container.firstElementChild).not.toHaveClass('pr-6');
  });

  it('spaces a centre-aligned header 0.375rem apart', () => {
    const { container } = render(<OverlayHeader title="Title" align="center" />);

    expect(container.firstElementChild).toHaveClass('gap-1.5');
  });

  it('writes the step as "Step N of M" before the heading', () => {
    render(<OverlayHeader title="Verify" step={{ current: 2, total: 4 }} />);

    const step = screen.getByText('Step 2 of 4');
    const heading = screen.getByRole('heading', { level: 2 });
    expect(step.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sets the step in small muted text', () => {
    render(<OverlayHeader title="Verify" step={{ current: 1, total: 3 }} />);

    expect(screen.getByText('Step 1 of 3')).toHaveClass('text-xs', 'text-muted-foreground');
  });

  it('keeps the step out of the heading', () => {
    render(<OverlayHeader title="Verify" step={{ current: 1, total: 3 }} />);

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Verify$/);
  });

  it('writes no step text while the step is pending', () => {
    const { container } = render(<OverlayHeader title="Verify" step="pending" />);

    expect(container).not.toHaveTextContent(/Step/);
  });

  it('hides a pending step line from sight and from assistive technology', () => {
    const { container } = render(<OverlayHeader title="Verify" step="pending" />);

    const line = container.querySelector('[data-slot="overlay-step"]');
    expect(line).toHaveAttribute('aria-hidden', 'true');
    expect(line).toHaveClass('invisible');
  });

  it('draws a pending step line as the same element and type as a counted one', () => {
    const counted = render(<OverlayHeader title="Verify" step={{ current: 1, total: 3 }} />);
    const countedLine = counted.container.querySelector('[data-slot="overlay-step"]');
    const pending = render(<OverlayHeader title="Verify" step="pending" />);
    const pendingLine = pending.container.querySelector('[data-slot="overlay-step"]');

    expect(countedLine).toBeInstanceOf(HTMLElement);
    expect(pendingLine).toBeInstanceOf(HTMLElement);
    expect(pendingLine?.tagName).toBe(countedLine?.tagName);
    expect(pendingLine?.className.replace(/\s*\binvisible\b/, '')).toBe(countedLine?.className);
  });

  it('renders the media before the heading', () => {
    render(<OverlayHeader title="Title" media={<span>mark</span>} />);

    const media = screen.getByText('mark');
    const heading = screen.getByRole('heading', { level: 2 });
    expect(media.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the meta between the heading and the description', () => {
    render(<OverlayHeader title="Title" meta={<span>model line</span>} description="Desc" />);

    const meta = screen.getByText('model line');
    const heading = screen.getByRole('heading', { level: 2 });
    const description = screen.getByText('Desc');
    expect(heading.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      meta.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('keeps the media and the meta inside the header', () => {
    const { container } = render(
      <OverlayHeader title="Title" media={<span>mark</span>} meta={<span>model line</span>} />
    );

    expect(container.firstElementChild).toContainElement(screen.getByText('mark'));
    expect(container.firstElementChild).toContainElement(screen.getByText('model line'));
  });

  it('does not render description element when not provided', () => {
    const { container } = render(<OverlayHeader title="Title Only" />);

    expect(container.firstElementChild?.children).toHaveLength(1);
  });

  it('holds paragraphs in its description as valid markup, logging no nesting error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = render(
      <OverlayHeader
        title="Reopen AC-1?"
        description={
          <>
            <p>Two notes were recorded against this finding.</p>
            <p>The decision is archived, not lost.</p>
          </>
        }
      />
    );

    expect(container.querySelector('p p')).toBeNull();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
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

  it('tags the title with a caller-supplied test id', () => {
    render(<OverlayHeader title="Update Required" titleTestId="upgrade-required-title" />);

    expect(screen.getByTestId('upgrade-required-title')).toHaveTextContent('Update Required');
  });

  it('tags the description with a caller-supplied test id', () => {
    render(
      <OverlayHeader
        title="Title"
        description="Please refresh"
        descriptionTestId="upgrade-required-description"
      />
    );

    expect(screen.getByTestId('upgrade-required-description')).toHaveTextContent('Please refresh');
  });

  it('merges className on wrapper', () => {
    const { container } = render(<OverlayHeader title="Title" className="text-center" />);

    expect(container.firstElementChild?.className).toMatch(/text-center/);
  });
});
