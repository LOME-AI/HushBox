import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, onTestFinished, vi } from 'vitest';
import { Popover, PopoverTrigger, PopoverContent, PopoverAnchor } from './popover';
import { PortalContainerProvider } from './portal-container';

describe('Popover', () => {
  it('renders the trigger', () => {
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Panel</PopoverContent>
      </Popover>
    );

    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('keeps the content closed until the trigger is clicked', () => {
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Panel</PopoverContent>
      </Popover>
    );

    expect(screen.queryByText('Panel')).not.toBeInTheDocument();
  });

  it('opens the content when the trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Panel</PopoverContent>
      </Popover>
    );

    await user.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => {
      expect(screen.getByText('Panel')).toBeInTheDocument();
    });
  });

  it('marks the trigger with its data-slot', () => {
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Panel</PopoverContent>
      </Popover>
    );

    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute(
      'data-slot',
      'popover-trigger'
    );
  });

  it('marks the content with its data-slot', () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Panel</PopoverContent>
      </Popover>
    );

    expect(screen.getByText('Panel')).toHaveAttribute('data-slot', 'popover-content');
  });

  it('renders open content for a controlled open prop', () => {
    render(
      <Popover open onOpenChange={vi.fn()}>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Panel</PopoverContent>
      </Popover>
    );

    expect(screen.getByText('Panel')).toBeInTheDocument();
  });

  it('reports open changes to a controlled consumer', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Popover open={false} onOpenChange={onOpenChange}>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Panel</PopoverContent>
      </Popover>
    );

    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('returns focus to the trigger when the content closes', async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Panel</PopoverContent>
      </Popover>
    );

    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    await waitFor(() => {
      expect(screen.getByText('Panel')).toBeInTheDocument();
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it('reveals the first control when Tab wraps from the last control', async () => {
    const user = userEvent.setup();
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>
          <button type="button">First</button>
          <button type="button">Last</button>
        </PopoverContent>
      </Popover>
    );
    const first = screen.getByRole('button', { name: 'First' });
    await waitFor(() => {
      expect(first).toHaveFocus();
    });
    screen.getByRole('button', { name: 'Last' }).focus();
    const scrollIntoView = vi.spyOn(first, 'scrollIntoView');

    await user.tab();

    expect(first).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it("runs the consumer's own onKeyDown", async () => {
    const user = userEvent.setup();
    const onKeyDown = vi.fn();
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent onKeyDown={onKeyDown}>
          <button type="button">Inside</button>
        </PopoverContent>
      </Popover>
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus();
    });

    await user.keyboard('{Enter}');

    expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }));
  });

  it('leaves the rest of the page reachable while open', () => {
    render(
      <>
        <button type="button">Outside</button>
        <Popover open>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>Panel</PopoverContent>
        </Popover>
      </>
    );

    expect(screen.getByRole('button', { name: 'Outside' })).toBeInTheDocument();
  });

  it('applies a consumer className to the content', () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent className="w-96">Panel</PopoverContent>
      </Popover>
    );

    expect(screen.getByText('Panel')).toHaveClass('w-96');
  });
});

describe('PopoverAnchor', () => {
  it('anchors the content to an element other than the trigger', () => {
    render(
      <Popover open>
        <PopoverAnchor>
          <span>Anchor</span>
        </PopoverAnchor>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Panel</PopoverContent>
      </Popover>
    );

    expect(screen.getByText('Anchor')).toBeInTheDocument();
    expect(screen.getByText('Panel')).toBeInTheDocument();
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

describe('PopoverContent portal', () => {
  it('portals the content to the document body when given no container', () => {
    const { container } = render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Panel</PopoverContent>
      </Popover>
    );

    const holder = bodyChildHolding(screen.getByText('Panel'));
    expect(holder).toBeDefined();
    expect(holder).not.toBe(container);
  });

  it('portals the content into the container it is given', () => {
    const target = portalTarget();
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent container={target}>Panel</PopoverContent>
      </Popover>
    );

    expect(target).toContainElement(screen.getByText('Panel'));
  });

  it('portals the content into the element its provider gives', () => {
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <Popover open>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>Panel</PopoverContent>
        </Popover>
      </PortalContainerProvider>
    );

    expect(target).toContainElement(screen.getByText('Panel'));
  });

  it('portals the content into its own container over the provider', () => {
    const provided = portalTarget();
    const own = portalTarget();
    render(
      <PortalContainerProvider container={provided}>
        <Popover open>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent container={own}>Panel</PopoverContent>
        </Popover>
      </PortalContainerProvider>
    );

    expect(own).toContainElement(screen.getByText('Panel'));
    expect(provided).not.toContainElement(screen.getByText('Panel'));
  });
});
