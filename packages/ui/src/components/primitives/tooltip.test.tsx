import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, onTestFinished, vi } from 'vitest';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './tooltip';
import { PortalContainerProvider } from './portal-container';

describe('Tooltip', () => {
  it('renders trigger element', () => {
    render(
      <Tooltip>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent>Tooltip text</TooltipContent>
      </Tooltip>
    );
    expect(screen.getByText('Hover me')).toBeInTheDocument();
  });

  it('trigger has data-slot attribute', () => {
    render(
      <Tooltip>
        <TooltipTrigger data-testid="trigger">Hover me</TooltipTrigger>
        <TooltipContent>Tooltip text</TooltipContent>
      </Tooltip>
    );
    expect(screen.getByTestId('trigger')).toHaveAttribute('data-slot', 'tooltip-trigger');
  });

  it('renders as button by default', () => {
    render(
      <Tooltip>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent>Tooltip text</TooltipContent>
      </Tooltip>
    );
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('renders open tooltip when defaultOpen is true', () => {
    render(
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('applies custom className to content', () => {
    render(
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent className="custom-class" data-testid="content">
          Tooltip text
        </TooltipContent>
      </Tooltip>
    );
    expect(screen.getByTestId('content')).toHaveClass('custom-class');
  });

  it('caps its width at 16rem', () => {
    render(
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );
    expect(screen.getByTestId('content')).toHaveClass('max-w-64');
  });

  it("lets a caller's own width cap replace the 16rem cap", () => {
    render(
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent className="max-w-xs" data-testid="content">
          Tooltip text
        </TooltipContent>
      </Tooltip>
    );
    expect(screen.getByTestId('content')).not.toHaveClass('max-w-64');
  });
});

describe('TooltipProvider', () => {
  it('renders children', () => {
    render(
      <TooltipProvider>
        <div>Child content</div>
      </TooltipProvider>
    );
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('accepts custom delayDuration', () => {
    render(
      <TooltipProvider delayDuration={500}>
        <Tooltip>
          <TooltipTrigger>Hover</TooltipTrigger>
          <TooltipContent>Content</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    expect(screen.getByText('Hover')).toBeInTheDocument();
  });
});

describe('Tooltip (touch mode)', () => {
  const originalMatchMedia = globalThis.matchMedia;

  const enableTouchMode = (): void => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  };

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  it('opens tooltip on trigger click', async () => {
    enableTouchMode();
    const user = userEvent.setup();

    render(
      <Tooltip>
        <TooltipTrigger>Tap me</TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );

    expect(screen.queryByTestId('content')).not.toBeInTheDocument();

    await user.click(screen.getByText('Tap me'));

    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('closes tooltip on second trigger click (toggle)', async () => {
    enableTouchMode();
    const user = userEvent.setup();

    render(
      <Tooltip>
        <TooltipTrigger>Tap me</TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );

    await user.click(screen.getByText('Tap me'));
    expect(screen.getByTestId('content')).toBeInTheDocument();

    await user.click(screen.getByText('Tap me'));
    expect(screen.queryByTestId('content')).not.toBeInTheDocument();
  });

  it('preserves data-slot attribute on trigger in touch mode', () => {
    enableTouchMode();

    render(
      <Tooltip>
        <TooltipTrigger data-testid="trigger">Tap me</TooltipTrigger>
        <TooltipContent>Tooltip text</TooltipContent>
      </Tooltip>
    );

    expect(screen.getByTestId('trigger')).toHaveAttribute('data-slot', 'tooltip-trigger');
  });

  it('fires child onClick alongside tooltip toggle with asChild', async () => {
    enableTouchMode();
    const user = userEvent.setup();
    const childOnClick = vi.fn();

    render(
      <Tooltip>
        <TooltipTrigger asChild>
          <button onClick={childOnClick}>Action</button>
        </TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );

    await user.click(screen.getByText('Action'));

    expect(childOnClick).toHaveBeenCalledOnce();
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('renders trigger correctly with asChild span', () => {
    enableTouchMode();

    render(
      <Tooltip>
        <TooltipTrigger asChild>
          <span data-testid="badge">Icon</span>
        </TooltipTrigger>
        <TooltipContent>Badge info</TooltipContent>
      </Tooltip>
    );

    expect(screen.getByTestId('badge')).toBeInTheDocument();
    expect(screen.getByTestId('badge').tagName).toBe('SPAN');
  });

  it('respects a controlled open prop and reports changes in touch mode', async () => {
    enableTouchMode();
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <Tooltip open={true} onOpenChange={onOpenChange}>
        <TooltipTrigger>Tap me</TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );

    // Controlled open=true shows content without any interaction.
    expect(screen.getByTestId('content')).toBeInTheDocument();

    await user.click(screen.getByText('Tap me'));
    // Toggling asks the controller to close; internal state is not used.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('leaves the trigger focused after a tap', async () => {
    enableTouchMode();
    const user = userEvent.setup();

    render(
      <Tooltip>
        <TooltipTrigger>Tap me</TooltipTrigger>
        <TooltipContent>Tooltip text</TooltipContent>
      </Tooltip>
    );

    const trigger = screen.getByText('Tap me');
    await user.click(trigger);

    expect(trigger).toHaveFocus();
  });

  it('toggles from a keyboard activation that no pointerdown preceded', () => {
    enableTouchMode();

    render(
      <Tooltip>
        <TooltipTrigger>Tap me</TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );

    const trigger = screen.getByText('Tap me');
    fireEvent.click(trigger);
    expect(screen.getByTestId('content')).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.queryByTestId('content')).not.toBeInTheDocument();
  });

  it('still dismisses on a pointerdown outside the trigger', async () => {
    enableTouchMode();
    const user = userEvent.setup();

    render(
      <Tooltip>
        <TooltipTrigger>Tap me</TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );

    await user.click(screen.getByText('Tap me'));
    expect(screen.getByTestId('content')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId('content')).not.toBeInTheDocument();
  });

  it('lets a wrapped anchor follow its href on tap', async () => {
    enableTouchMode();
    const user = userEvent.setup();

    render(
      <Tooltip>
        <TooltipTrigger asChild>
          <a href="#tooltip-target">Open details</a>
        </TooltipTrigger>
        <TooltipContent>Tooltip text</TooltipContent>
      </Tooltip>
    );

    await user.click(screen.getByText('Open details'));

    expect(globalThis.location.hash).toBe('#tooltip-target');
  });

  it('forwards pointer-leave and blur events to caller handlers in touch mode', () => {
    enableTouchMode();
    const onPointerLeave = vi.fn();
    const onBlur = vi.fn();
    const onPointerMove = vi.fn();

    render(
      <Tooltip>
        <TooltipTrigger
          onPointerLeave={onPointerLeave}
          onBlur={onBlur}
          onPointerMove={onPointerMove}
        >
          Tap me
        </TooltipTrigger>
        <TooltipContent>Tooltip text</TooltipContent>
      </Tooltip>
    );

    const trigger = screen.getByText('Tap me');
    fireEvent.pointerMove(trigger);
    fireEvent.pointerLeave(trigger);
    fireEvent.blur(trigger);

    expect(onPointerMove).toHaveBeenCalledOnce();
    expect(onPointerLeave).toHaveBeenCalledOnce();
    expect(onBlur).toHaveBeenCalledOnce();
  });
});

/**
 * happy-dom matches `:focus-visible` exactly as `:focus`, so it has no pointer-versus-keyboard
 * heuristic to produce a focus the browser would not mark visible. This spy stands in for a
 * browser after a pointer or touch interaction.
 */
function focusIsNotKeyboardVisible(): void {
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
    this: Element,
    selectors: string
  ): boolean {
    return selectors === ':focus-visible' ? false : matches.call(this, selectors);
  });
}

describe('Tooltip on focus', () => {
  const originalMatchMedia = globalThis.matchMedia;

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  it('opens when the focus is keyboard-visible', () => {
    render(
      <Tooltip>
        <TooltipTrigger>Share</TooltipTrigger>
        <TooltipContent data-testid="content">Share</TooltipContent>
      </Tooltip>
    );

    act(() => {
      screen.getByRole('button', { name: 'Share' }).focus();
    });

    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('stays closed when the focus is not keyboard-visible', () => {
    focusIsNotKeyboardVisible();
    render(
      <Tooltip>
        <TooltipTrigger>Share</TooltipTrigger>
        <TooltipContent data-testid="content">Share</TooltipContent>
      </Tooltip>
    );

    act(() => {
      screen.getByRole('button', { name: 'Share' }).focus();
    });

    expect(screen.queryByTestId('content')).not.toBeInTheDocument();
  });

  it('stays closed in touch mode when the focus is not keyboard-visible', () => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    focusIsNotKeyboardVisible();
    render(
      <Tooltip>
        <TooltipTrigger>Share</TooltipTrigger>
        <TooltipContent data-testid="content">Share</TooltipContent>
      </Tooltip>
    );

    act(() => {
      screen.getByRole('button', { name: 'Share' }).focus();
    });

    expect(screen.queryByTestId('content')).not.toBeInTheDocument();
  });

  it("still calls the trigger's own focus handler", () => {
    focusIsNotKeyboardVisible();
    const onFocus = vi.fn();
    render(
      <Tooltip>
        <TooltipTrigger onFocus={onFocus}>Share</TooltipTrigger>
        <TooltipContent>Share</TooltipContent>
      </Tooltip>
    );

    act(() => {
      screen.getByRole('button', { name: 'Share' }).focus();
    });

    expect(onFocus).toHaveBeenCalledOnce();
  });
});

/** An element outside the rendered tree for a portal to land in, removed after the test. */
function portalTarget(): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  onTestFinished(() => {
    target.remove();
  });
  return target;
}

/** The element directly under the document body that holds `element`. */
function bodyChildHolding(element: HTMLElement): Element | undefined {
  return [...document.body.children].find((child) => child.contains(element));
}

describe('TooltipContent portal', () => {
  it('portals the tooltip to the document body when given no container', () => {
    const { container } = render(
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );

    const holder = bodyChildHolding(screen.getByTestId('content'));
    expect(holder).toBeDefined();
    expect(holder).not.toBe(container);
  });

  it('portals the tooltip into the container it is given', () => {
    const target = portalTarget();
    render(
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent data-testid="content" container={target}>
          Tooltip text
        </TooltipContent>
      </Tooltip>
    );

    expect(target).toContainElement(screen.getByTestId('content'));
  });

  it('portals the tooltip into the element its provider gives', () => {
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <Tooltip defaultOpen>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipContent data-testid="content">Tooltip text</TooltipContent>
        </Tooltip>
      </PortalContainerProvider>
    );

    expect(target).toContainElement(screen.getByTestId('content'));
  });

  it('portals the tooltip into its own container over the provider', () => {
    const provided = portalTarget();
    const own = portalTarget();
    render(
      <PortalContainerProvider container={provided}>
        <Tooltip defaultOpen>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipContent data-testid="content" container={own}>
            Tooltip text
          </TooltipContent>
        </Tooltip>
      </PortalContainerProvider>
    );

    expect(own).toContainElement(screen.getByTestId('content'));
    expect(provided).not.toContainElement(screen.getByTestId('content'));
  });
});
