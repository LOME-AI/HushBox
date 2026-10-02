import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, onTestFinished, vi } from 'vitest';
import {
  Sheet as PublishedSheet,
  SheetContent as PublishedSheetContent,
  SheetTitle as PublishedSheetTitle,
} from '@hushbox/ui';
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from './sheet';
import { SCRIM_BASE_CLASS, SCRIM_BLUR_CLASS } from '../overlay/scrim';
import { PortalContainerProvider } from './portal-container';

describe('Sheet', () => {
  it('renders trigger element', () => {
    render(
      <Sheet>
        <SheetTrigger>Open Sheet</SheetTrigger>
        <SheetContent>
          <SheetTitle>Title</SheetTitle>
        </SheetContent>
      </Sheet>
    );
    expect(screen.getByText('Open Sheet')).toBeInTheDocument();
  });

  it('opens sheet when trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open Sheet</SheetTrigger>
        <SheetContent>
          <SheetTitle>Sheet Title</SheetTitle>
          <SheetDescription>Sheet description</SheetDescription>
        </SheetContent>
      </Sheet>
    );

    await user.click(screen.getByText('Open Sheet'));
    await waitFor(() => {
      expect(screen.getByText('Sheet Title')).toBeInTheDocument();
      expect(screen.getByText('Sheet description')).toBeInTheDocument();
    });
  });

  it('closes sheet when close button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open Sheet</SheetTrigger>
        <SheetContent>
          <SheetTitle>Sheet Title</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    await user.click(screen.getByText('Open Sheet'));
    await waitFor(() => {
      expect(screen.getByText('Sheet Title')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() => {
      expect(screen.queryByText('Sheet Title')).not.toBeInTheDocument();
    });
  });

  it('has cursor-pointer on close button', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open Sheet</SheetTrigger>
        <SheetContent>
          <SheetTitle>Sheet Title</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    await user.click(screen.getByText('Open Sheet'));
    await waitFor(() => {
      expect(screen.getByText('Sheet Title')).toBeInTheDocument();
    });

    const closeButton = screen.getByRole('button', { name: /close/i });
    expect(closeButton).toHaveClass('cursor-pointer');
  });

  it('renders with different sides', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent side="left">
          <SheetTitle>Left Sheet</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByText('Left Sheet')).toBeInTheDocument();
    });
  });

  it('can hide close button', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open Sheet</SheetTrigger>
        <SheetContent showCloseButton={false}>
          <SheetTitle>Sheet Title</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    await user.click(screen.getByText('Open Sheet'));
    await waitFor(() => {
      expect(screen.getByText('Sheet Title')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('scrolls internally so tall content keeps actions reachable', () => {
    render(
      <Sheet open={true}>
        <SheetContent>
          <SheetTitle>Scrollable Sheet</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(screen.getByRole('dialog')).toHaveClass('overflow-y-auto');
  });

  it.each(['top', 'bottom'] as const)('caps %s-anchored sheet height to the viewport', (side) => {
    render(
      <Sheet open={true}>
        <SheetContent side={side}>
          <SheetTitle>Capped Sheet</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(screen.getByRole('dialog')).toHaveClass('max-h-[calc(100dvh-2rem)]');
  });

  it('renders controlled sheet', () => {
    const onOpenChange = vi.fn();
    render(
      <Sheet open={true} onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetTitle>Controlled Sheet</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(screen.getByText('Controlled Sheet')).toBeInTheDocument();
  });

  it('cycles tab focus between its own close button and the content, never leaving', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Outside</button>
        <Sheet>
          <SheetTrigger>Open</SheetTrigger>
          <SheetContent>
            <SheetTitle>Title</SheetTitle>
            <SheetDescription>Description</SheetDescription>
            <button type="button">Inside</button>
          </SheetContent>
        </Sheet>
      </>
    );

    const outside = screen.getByRole('button', { name: 'Outside' });
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    await user.tab();
    const first = document.activeElement;
    await user.tab();
    const second = document.activeElement;
    await user.tab();
    const third = document.activeElement;

    expect(first).toBe(screen.getByRole('button', { name: 'Close' }));
    expect(second).toBe(screen.getByRole('button', { name: 'Inside' }));
    expect(third).toBe(first);
    expect(outside).not.toHaveFocus();
  });

  it('returns focus to the trigger when its own close button is activated by keyboard', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent>
          <SheetTitle>Title</SheetTitle>
          <SheetDescription>Description</SheetDescription>
          <button type="button">Inside</button>
        </SheetContent>
      </Sheet>
    );

    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });
});

describe('Sheet scrim', () => {
  function renderOpenSheet(): HTMLElement {
    render(
      <Sheet open={true}>
        <SheetContent>
          <SheetTitle>Title</SheetTitle>
        </SheetContent>
      </Sheet>
    );
    const scrim = document.querySelector<HTMLElement>('[data-slot="sheet-overlay"]');
    if (scrim === null) throw new Error('the open sheet drew no scrim');
    return scrim;
  }

  it("draws the recipe's base scrim", () => {
    expect(renderOpenSheet()).toHaveClass(...SCRIM_BASE_CLASS.split(' '));
  });

  it("draws the scrim without the recipe's blur", () => {
    expect(renderOpenSheet()).not.toHaveClass(...SCRIM_BLUR_CLASS.split(' '));
  });
});

describe('SheetHeader', () => {
  it('renders children', () => {
    render(<SheetHeader>Header content</SheetHeader>);
    expect(screen.getByText('Header content')).toBeInTheDocument();
  });

  it('has data-slot attribute', () => {
    render(<SheetHeader data-testid="header">Content</SheetHeader>);
    expect(screen.getByTestId('header')).toHaveAttribute('data-slot', 'sheet-header');
  });

  it('applies custom className', () => {
    render(
      <SheetHeader className="custom-class" data-testid="header">
        Content
      </SheetHeader>
    );
    expect(screen.getByTestId('header')).toHaveClass('custom-class');
  });
});

describe('SheetClose', () => {
  it('closes sheet when clicked', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent>
          <SheetTitle>Title</SheetTitle>
          <SheetClose>Custom Close</SheetClose>
        </SheetContent>
      </Sheet>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByText('Title')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Custom Close'));
    await waitFor(() => {
      expect(screen.queryByText('Title')).not.toBeInTheDocument();
    });
  });

  it.each([
    ['left', 'slide-in-from-left'],
    ['top', 'slide-in-from-top'],
    ['bottom', 'slide-in-from-bottom'],
  ] as const)('renders %s-side content with the matching slide animation', async (side, cls) => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open Sheet</SheetTrigger>
        <SheetContent side={side}>
          <SheetTitle>Side Title</SheetTitle>
        </SheetContent>
      </Sheet>
    );
    await user.click(screen.getByText('Open Sheet'));
    await waitFor(() => {
      const content = document.querySelector('[data-slot="sheet-content"]');
      expect(content).not.toBeNull();
      expect(content!.className).toContain(cls);
    });
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

describe('SheetContent portal', () => {
  it('portals the sheet to the document body when given no container', () => {
    const { container } = render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Title</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    const sheet = screen.getByRole('dialog');
    expect(container).not.toContainElement(sheet);
    expect(sheet.parentElement).toBe(document.body);
  });

  it('portals the sheet into the container it is given', () => {
    const target = portalTarget();
    render(
      <Sheet open>
        <SheetContent container={target}>
          <SheetTitle>Title</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(target).toContainElement(screen.getByRole('dialog'));
  });

  it('portals the sheet into the element its provider gives', () => {
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <Sheet open>
          <SheetContent>
            <SheetTitle>Title</SheetTitle>
          </SheetContent>
        </Sheet>
      </PortalContainerProvider>
    );

    expect(target).toContainElement(screen.getByRole('dialog'));
  });

  it('portals the sheet into its own container over the provider', () => {
    const provided = portalTarget();
    const own = portalTarget();
    render(
      <PortalContainerProvider container={provided}>
        <Sheet open>
          <SheetContent container={own}>
            <SheetTitle>Title</SheetTitle>
          </SheetContent>
        </Sheet>
      </PortalContainerProvider>
    );

    expect(own).toContainElement(screen.getByRole('dialog'));
    expect(provided).not.toContainElement(screen.getByRole('dialog'));
  });

  it('is published from the package entry with the parts a caller composes it from', () => {
    expect(PublishedSheet).toBe(Sheet);
    expect(PublishedSheetContent).toBe(SheetContent);
    expect(PublishedSheetTitle).toBe(SheetTitle);
  });
});
