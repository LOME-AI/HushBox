import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, onTestFinished, vi } from 'vitest';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from './dialog';
import { PortalContainerProvider } from './portal-container';

describe('Dialog', () => {
  it('renders trigger element', () => {
    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    expect(screen.getByText('Open Dialog')).toBeInTheDocument();
  });

  it('opens dialog when trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogContent>
          <DialogTitle>Dialog Title</DialogTitle>
          <DialogDescription>Dialog description</DialogDescription>
        </DialogContent>
      </Dialog>
    );

    await user.click(screen.getByText('Open Dialog'));
    await waitFor(() => {
      expect(screen.getByText('Dialog Title')).toBeInTheDocument();
      expect(screen.getByText('Dialog description')).toBeInTheDocument();
    });
  });

  it('closes dialog when close button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogContent>
          <DialogTitle>Dialog Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    await user.click(screen.getByText('Open Dialog'));
    await waitFor(() => {
      expect(screen.getByText('Dialog Title')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() => {
      expect(screen.queryByText('Dialog Title')).not.toBeInTheDocument();
    });
  });

  it('has cursor-pointer on close button', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogContent>
          <DialogTitle>Dialog Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    await user.click(screen.getByText('Open Dialog'));
    await waitFor(() => {
      expect(screen.getByText('Dialog Title')).toBeInTheDocument();
    });

    const closeButton = screen.getByRole('button', { name: /close/i });
    expect(closeButton).toHaveClass('cursor-pointer');
  });

  it('can hide close button', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Dialog Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    await user.click(screen.getByText('Open Dialog'));
    await waitFor(() => {
      expect(screen.getByText('Dialog Title')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('renders controlled dialog', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open={true} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Controlled Dialog</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    expect(screen.getByText('Controlled Dialog')).toBeInTheDocument();
  });

  it('caps its own height and scrolls internally by default', () => {
    render(
      <Dialog open={true}>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    const content = screen.getByRole('dialog');
    expect(content).toHaveClass('max-h-[calc(100dvh-2rem)]');
    expect(content).toHaveClass('overflow-y-auto');
  });

  it('lets a consumer className override the default max-height with a single max-h class', () => {
    render(
      <Dialog open={true}>
        <DialogContent className="max-h-[90vh]">
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    const content = screen.getByRole('dialog');
    expect(content).toHaveClass('max-h-[90vh]');
    expect(content).not.toHaveClass('max-h-[calc(100dvh-2rem)]');
  });

  it('cycles tab focus between its own close button and the content, never leaving', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Outside</button>
        <Dialog>
          <DialogTrigger>Open</DialogTrigger>
          <DialogContent>
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Description</DialogDescription>
            <button type="button">Inside</button>
          </DialogContent>
        </Dialog>
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

  it('reveals the first control when Tab wraps from the last control', async () => {
    const user = userEvent.setup();
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Description</DialogDescription>
          <button type="button">First</button>
          <button type="button">Last</button>
        </DialogContent>
      </Dialog>
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
      <Dialog open>
        <DialogContent onKeyDown={onKeyDown}>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Description</DialogDescription>
          <button type="button">Inside</button>
        </DialogContent>
      </Dialog>
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus();
    });

    await user.keyboard('{Enter}');

    expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }));
  });

  it('returns focus to the trigger when its own close button is activated by keyboard', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Description</DialogDescription>
          <button type="button">Inside</button>
        </DialogContent>
      </Dialog>
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

describe('DialogHeader', () => {
  it('renders children', () => {
    render(<DialogHeader>Header content</DialogHeader>);
    expect(screen.getByText('Header content')).toBeInTheDocument();
  });

  it('has data-slot attribute', () => {
    render(<DialogHeader data-testid="header">Content</DialogHeader>);
    expect(screen.getByTestId('header')).toHaveAttribute('data-slot', 'dialog-header');
  });

  it('applies custom className', () => {
    render(
      <DialogHeader className="custom-class" data-testid="header">
        Content
      </DialogHeader>
    );
    expect(screen.getByTestId('header')).toHaveClass('custom-class');
  });
});

describe('DialogFooter', () => {
  it('renders children', () => {
    render(<DialogFooter>Footer content</DialogFooter>);
    expect(screen.getByText('Footer content')).toBeInTheDocument();
  });

  it('has data-slot attribute', () => {
    render(<DialogFooter data-testid="footer">Content</DialogFooter>);
    expect(screen.getByTestId('footer')).toHaveAttribute('data-slot', 'dialog-footer');
  });

  it('applies custom className', () => {
    render(
      <DialogFooter className="custom-class" data-testid="footer">
        Content
      </DialogFooter>
    );
    expect(screen.getByTestId('footer')).toHaveClass('custom-class');
  });
});

describe('DialogClose', () => {
  it('closes dialog when clicked', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Title</DialogTitle>
          <DialogClose>Custom Close</DialogClose>
        </DialogContent>
      </Dialog>
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

describe('DialogContent portal', () => {
  it('portals the dialog to the document body when given no container', () => {
    const { container } = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    const dialog = screen.getByRole('dialog');
    expect(container).not.toContainElement(dialog);
    expect(dialog.parentElement).toBe(document.body);
  });

  it('portals the dialog into the container it is given', () => {
    const target = portalTarget();
    render(
      <Dialog open>
        <DialogContent container={target}>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    expect(target).toContainElement(screen.getByRole('dialog'));
  });

  it('portals the dialog into the element its provider gives', () => {
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Title</DialogTitle>
          </DialogContent>
        </Dialog>
      </PortalContainerProvider>
    );

    expect(target).toContainElement(screen.getByRole('dialog'));
  });

  it('portals the dialog into its own container over the provider', () => {
    const provided = portalTarget();
    const own = portalTarget();
    render(
      <PortalContainerProvider container={provided}>
        <Dialog open>
          <DialogContent container={own}>
            <DialogTitle>Title</DialogTitle>
          </DialogContent>
        </Dialog>
      </PortalContainerProvider>
    );

    expect(own).toContainElement(screen.getByRole('dialog'));
    expect(provided).not.toContainElement(screen.getByRole('dialog'));
  });
});
