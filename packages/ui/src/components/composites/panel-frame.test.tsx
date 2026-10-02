import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PanelFrame } from './panel-frame';

describe('PanelFrame', () => {
  it('renders the title and the content', () => {
    render(
      <PanelFrame title="Money">
        <p>content here</p>
      </PanelFrame>
    );

    expect(screen.getByRole('heading', { name: 'Money' })).toBeInTheDocument();
    expect(screen.getByText('content here')).toBeInTheDocument();
  });

  it('renders a skeleton while loading, not the content', () => {
    render(
      <PanelFrame title="Money" loading>
        <p>content here</p>
      </PanelFrame>
    );

    expect(screen.queryByText('content here')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Money' })).toBeInTheDocument();
  });

  it('hides the loading skeleton from assistive technology', () => {
    const { container } = render(<PanelFrame title="Money" loading />);

    expect(container.querySelector('[data-slot="panel-frame-skeleton"]')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
  });

  it('renders an inline error instead of the content', () => {
    render(
      <PanelFrame title="Usage" error="unavailable">
        <p>content here</p>
      </PanelFrame>
    );

    const error = screen.getByText(/Failed to load/);
    expect(error).toHaveTextContent('unavailable');
    expect(screen.queryByText('content here')).not.toBeInTheDocument();
  });

  it('prefers the loading branch over the error branch', () => {
    render(<PanelFrame title="Usage" loading error="unavailable" />);

    expect(screen.queryByText(/Failed to load/)).not.toBeInTheDocument();
  });

  it('tags the error with a caller-supplied test id', () => {
    render(<PanelFrame title="Usage" error="unavailable" errorTestId="panel-error" />);

    expect(screen.getByTestId('panel-error')).toHaveTextContent('unavailable');
  });

  it('has a data-slot attribute', () => {
    render(<PanelFrame title="Money" data-testid="panel" />);

    expect(screen.getByTestId('panel')).toHaveAttribute('data-slot', 'panel-frame');
  });

  it('applies a custom className to the panel root', () => {
    render(<PanelFrame title="Money" className="col-span-2" data-testid="panel" />);

    expect(screen.getByTestId('panel')).toHaveClass('col-span-2', 'rounded-md');
  });

  it('titles the panel at the second level when the caller names none', () => {
    render(<PanelFrame title="Money" />);

    expect(screen.getByRole('heading', { name: 'Money', level: 2 })).toBeInTheDocument();
  });

  it('titles the panel at the level the caller names', () => {
    render(<PanelFrame title="Money" headingLevel={3} />);

    expect(screen.getByRole('heading', { name: 'Money', level: 3 })).toBeInTheDocument();
  });

  it('renders the actions beside the title rather than inside the body', () => {
    const { container } = render(
      <PanelFrame title="Money" actions={<button type="button">Export CSV</button>}>
        <p>content here</p>
      </PanelFrame>
    );

    expect(container.querySelector('[data-slot="panel-frame-header"]')).toContainElement(
      screen.getByRole('button', { name: 'Export CSV' })
    );
    expect(container.querySelector('[data-slot="panel-frame-body"]')).not.toContainElement(
      screen.getByRole('button', { name: 'Export CSV' })
    );
  });

  it('renders the scope slot beside the title', () => {
    const { container } = render(
      <PanelFrame title="Money" scope={<span>Selected week</span>}>
        <p>content here</p>
      </PanelFrame>
    );

    expect(container.querySelector('[data-slot="panel-frame-header"]')).toContainElement(
      screen.getByText('Selected week')
    );
  });

  it('omits both header slots when the caller fills neither', () => {
    const { container } = render(<PanelFrame title="Money" />);

    expect(container.querySelector('[data-slot="panel-frame-scope"]')).toBeNull();
    expect(container.querySelector('[data-slot="panel-frame-actions"]')).toBeNull();
  });

  it('keeps the header while the body carries the error', () => {
    const { container } = render(<PanelFrame title="Usage" error="unavailable" />);

    expect(container.querySelector('[data-slot="panel-frame-header"]')).toContainElement(
      screen.getByRole('heading', { name: 'Usage' })
    );
  });

  it('holds the room a short panel declares', () => {
    const { container } = render(<PanelFrame title="How current this data is" reserves="short" />);

    expect(container.querySelector('[data-slot="panel-frame-body"]')).toHaveClass('min-h-14');
  });

  it('holds the room a medium panel declares', () => {
    const { container } = render(<PanelFrame title="This week" reserves="medium" />);

    expect(container.querySelector('[data-slot="panel-frame-body"]')).toHaveClass('min-h-60');
  });

  it('holds the room a tall panel declares', () => {
    const { container } = render(<PanelFrame title="Where visitors are" reserves="tall" />);

    expect(container.querySelector('[data-slot="panel-frame-body"]')).toHaveClass('min-h-112');
  });

  it('keeps the room while the read is in flight', () => {
    const { container } = render(<PanelFrame title="This week" loading reserves="medium" />);

    expect(container.querySelector('[data-slot="panel-frame-body"]')).toHaveClass('min-h-60');
  });

  it('keeps the room once the read has failed', () => {
    const { container } = render(
      <PanelFrame title="This week" error="PANEL_UNAVAILABLE" reserves="medium" />
    );

    expect(container.querySelector('[data-slot="panel-frame-body"]')).toHaveClass('min-h-60');
  });

  it('keeps the room once the panel has drawn less than it holds', () => {
    const { container } = render(
      <PanelFrame title="This week" reserves="medium">
        <p>one short sentence</p>
      </PanelFrame>
    );

    expect(container.querySelector('[data-slot="panel-frame-body"]')).toHaveClass('min-h-60');
  });

  it('holds no room when the caller declares no size', () => {
    const { container } = render(<PanelFrame title="Money" loading />);

    expect(container.querySelector('[data-slot="panel-frame-body"]')?.className).not.toMatch(
      /min-h-/
    );
  });

  it('draws a two-bar placeholder when the caller declares no size', () => {
    const { container } = render(<PanelFrame title="Money" loading />);

    const skeleton = container.querySelector('[data-slot="panel-frame-skeleton"]');
    expect(skeleton?.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);
  });

  it('draws a longer skeleton ladder the more room a panel holds', () => {
    const bars = (reserves: 'short' | 'medium' | 'tall'): number => {
      const { container, unmount } = render(
        <PanelFrame title="This week" loading reserves={reserves} />
      );
      const count =
        container
          .querySelector('[data-slot="panel-frame-skeleton"]')
          ?.querySelectorAll('[data-slot="skeleton"]').length ?? 0;
      unmount();
      return count;
    };

    expect(bars('short')).toBeLessThan(bars('medium'));
    expect(bars('medium')).toBeLessThan(bars('tall'));
  });

  it('stretches the skeleton ladder across the room it holds', () => {
    const { container } = render(<PanelFrame title="This week" loading reserves="tall" />);

    const skeleton = container.querySelector('[data-slot="panel-frame-skeleton"]');
    expect(skeleton).toHaveClass('grow');
    expect(skeleton?.querySelector('[data-slot="skeleton"]')).toHaveClass('grow');
  });
});
