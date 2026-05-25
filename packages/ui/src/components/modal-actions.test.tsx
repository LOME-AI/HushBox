import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ModalActions } from './modal-actions';

describe('ModalActions', () => {
  describe('single button mode (cancel omitted)', () => {
    it('renders primary button with w-full class', () => {
      render(<ModalActions primary={{ label: 'Submit', onClick: vi.fn() }} />);
      const button = screen.getByRole('button', { name: 'Submit' });
      expect(button).toBeInTheDocument();
      expect(button.className).toContain('w-full');
    });

    it('fires onClick when primary button is clicked', async () => {
      const user = userEvent.setup();
      const onClick = vi.fn();
      render(<ModalActions primary={{ label: 'Submit', onClick }} />);
      await user.click(screen.getByRole('button', { name: 'Submit' }));
      expect(onClick).toHaveBeenCalledOnce();
    });

    it('applies default variant to primary button', () => {
      render(<ModalActions primary={{ label: 'Submit', onClick: vi.fn() }} />);
      expect(screen.getByRole('button', { name: 'Submit' })).toHaveAttribute(
        'data-variant',
        'default'
      );
    });

    it('does not render a container div', () => {
      const { container } = render(
        <ModalActions primary={{ label: 'Submit', onClick: vi.fn() }} />
      );
      // The root element should be the button itself, not a wrapper div
      expect(container.querySelector('div.flex')).not.toBeInTheDocument();
    });
  });

  describe('two-button mode (cancel provided)', () => {
    it('renders both buttons in a flex gap-2 container', () => {
      const { container } = render(
        <ModalActions
          cancel={{ label: 'Cancel', onClick: vi.fn() }}
          primary={{ label: 'Submit', onClick: vi.fn() }}
        />
      );
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain('flex');
      expect(wrapper.className).toContain('gap-2');
    });

    it('gives both buttons flex-1 class', () => {
      render(
        <ModalActions
          cancel={{ label: 'Cancel', onClick: vi.fn() }}
          primary={{ label: 'Submit', onClick: vi.fn() }}
        />
      );
      expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('flex-1');
      expect(screen.getByRole('button', { name: 'Submit' }).className).toContain('flex-1');
    });

    it('renders cancel before primary in DOM order', () => {
      render(
        <ModalActions
          cancel={{ label: 'Cancel', onClick: vi.fn() }}
          primary={{ label: 'Submit', onClick: vi.fn() }}
        />
      );
      const buttons = screen.getAllByRole('button');
      expect(buttons[0]).toHaveTextContent('Cancel');
      expect(buttons[1]).toHaveTextContent('Submit');
    });

    it('applies outline variant to cancel and default variant to primary', () => {
      render(
        <ModalActions
          cancel={{ label: 'Cancel', onClick: vi.fn() }}
          primary={{ label: 'Submit', onClick: vi.fn() }}
        />
      );
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute(
        'data-variant',
        'outline'
      );
      expect(screen.getByRole('button', { name: 'Submit' })).toHaveAttribute(
        'data-variant',
        'default'
      );
    });

    it('fires cancel onClick when cancel is clicked', async () => {
      const user = userEvent.setup();
      const onCancel = vi.fn();
      render(
        <ModalActions
          cancel={{ label: 'Cancel', onClick: onCancel }}
          primary={{ label: 'Submit', onClick: vi.fn() }}
        />
      );
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onCancel).toHaveBeenCalledOnce();
    });
  });

  describe('custom variant', () => {
    it('overrides default variant on primary', () => {
      render(
        <ModalActions
          cancel={{ label: 'Cancel', onClick: vi.fn() }}
          primary={{ label: 'Remove', variant: 'destructive', onClick: vi.fn() }}
        />
      );
      expect(screen.getByRole('button', { name: 'Remove' })).toHaveAttribute(
        'data-variant',
        'destructive'
      );
    });

    it('allows outline variant on single primary button', () => {
      render(<ModalActions primary={{ label: 'Close', variant: 'outline', onClick: vi.fn() }} />);
      expect(screen.getByRole('button', { name: 'Close' })).toHaveAttribute(
        'data-variant',
        'outline'
      );
    });
  });

  describe('loading state', () => {
    it('shows spinner and loadingLabel when loading is true', () => {
      render(
        <ModalActions
          primary={{ label: 'Save', onClick: vi.fn(), loading: true, loadingLabel: 'Saving...' }}
        />
      );
      const button = screen.getByRole('button', { name: /Saving/ });
      expect(button).toBeInTheDocument();
      expect(button.querySelector('svg')).toBeInTheDocument();
    });

    it('disables button when loading', () => {
      render(
        <ModalActions
          primary={{ label: 'Save', onClick: vi.fn(), loading: true, loadingLabel: 'Saving...' }}
        />
      );
      expect(screen.getByRole('button', { name: /Saving/ })).toBeDisabled();
    });

    it('falls back to label when loadingLabel is not provided', () => {
      render(<ModalActions primary={{ label: 'Save', onClick: vi.fn(), loading: true }} />);
      expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
    });
  });

  describe('disabled state', () => {
    it('disables button without a visible spinner when disabled is true', () => {
      render(<ModalActions primary={{ label: 'Submit', onClick: vi.fn(), disabled: true }} />);
      const button = screen.getByRole('button', { name: 'Submit' });
      expect(button).toBeDisabled();
      // Spinner may exist in the hidden width-reservation slot; the visible
      // content slot must be spinner-free when not loading.
      const visible = button.querySelector('[data-slot="button-visible"]');
      expect(visible).not.toBeNull();
      expect(visible?.querySelector('svg')).not.toBeInTheDocument();
    });
  });

  describe('icon', () => {
    it('renders icon before label', () => {
      render(
        <ModalActions
          primary={{ label: 'Copy', onClick: vi.fn(), icon: <span data-testid="copy-icon" /> }}
        />
      );
      expect(screen.getByTestId('copy-icon')).toBeInTheDocument();
      const button = screen.getByRole('button', { name: /Copy/ });
      expect(button).toContainElement(screen.getByTestId('copy-icon'));
    });

    it('hides icon and shows spinner in the visible slot during loading', () => {
      render(
        <ModalActions
          primary={{
            label: 'Copy',
            onClick: vi.fn(),
            icon: <span data-testid="copy-icon" />,
            loading: true,
            loadingLabel: 'Copying...',
          }}
        />
      );
      const button = screen.getByRole('button', { name: /Copying/ });
      const visible = button.querySelector<HTMLElement>('[data-slot="button-visible"]')!;
      // Visible slot shows the spinner and not the icon (icon is in the
      // hidden reservation slot to keep button width stable across states).
      expect(within(visible).queryByTestId('copy-icon')).not.toBeInTheDocument();
      expect(visible.querySelector('svg')).toBeInTheDocument();
    });
  });

  describe('testId', () => {
    it('passes testId as data-testid on buttons', () => {
      render(
        <ModalActions
          cancel={{ label: 'Cancel', onClick: vi.fn(), testId: 'my-cancel' }}
          primary={{ label: 'Submit', onClick: vi.fn(), testId: 'my-submit' }}
        />
      );
      expect(screen.getByTestId('my-cancel')).toBeInTheDocument();
      expect(screen.getByTestId('my-submit')).toBeInTheDocument();
    });
  });

  describe('type', () => {
    it('defaults button type to button', () => {
      render(<ModalActions primary={{ label: 'Submit', onClick: vi.fn() }} />);
      expect(screen.getByRole('button', { name: 'Submit' })).toHaveAttribute('type', 'button');
    });

    it('applies type="submit" when specified', () => {
      render(<ModalActions primary={{ label: 'Purchase', onClick: vi.fn(), type: 'submit' }} />);
      expect(screen.getByRole('button', { name: 'Purchase' })).toHaveAttribute('type', 'submit');
    });
  });

  describe('form', () => {
    it('passes form attribute to the button', () => {
      render(
        <ModalActions
          primary={{ label: 'Save', onClick: vi.fn(), type: 'submit', form: 'my-form' }}
        />
      );
      expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('form', 'my-form');
    });

    it('does not render form attribute when not specified', () => {
      render(<ModalActions primary={{ label: 'Save', onClick: vi.fn() }} />);
      expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute('form');
    });
  });

  describe('className', () => {
    it('applies className to container in two-button mode', () => {
      const { container } = render(
        <ModalActions
          cancel={{ label: 'Cancel', onClick: vi.fn() }}
          primary={{ label: 'Submit', onClick: vi.fn() }}
          className="mt-6"
        />
      );
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain('mt-6');
    });
  });

  // Both label and loadingLabel must occupy layout space simultaneously so the
  // button's width does not change when `loading` toggles. We achieve this by
  // rendering both contents stacked: one is visible, the other is invisible
  // (visibility:hidden, still in flow) — the container sizes to max of both.
  describe('width stability across loading states', () => {
    it('renders both visible and reservation slots in idle state', () => {
      render(
        <ModalActions primary={{ label: 'Save', loadingLabel: 'Saving...', onClick: vi.fn() }} />
      );
      const button = screen.getByRole('button', { name: 'Save' });
      expect(button.querySelector('[data-slot="button-visible"]')).not.toBeNull();
      expect(button.querySelector('[data-slot="button-reservation"]')).not.toBeNull();
    });

    it('keeps both label texts in DOM regardless of loading state', () => {
      const { rerender } = render(
        <ModalActions primary={{ label: 'Save', loadingLabel: 'Saving...', onClick: vi.fn() }} />
      );
      const buttonIdle = screen.getByRole('button');
      expect(buttonIdle.textContent).toContain('Save');
      expect(buttonIdle.textContent).toContain('Saving...');

      rerender(
        <ModalActions
          primary={{
            label: 'Save',
            loadingLabel: 'Saving...',
            loading: true,
            onClick: vi.fn(),
          }}
        />
      );
      const buttonLoading = screen.getByRole('button');
      expect(buttonLoading.textContent).toContain('Save');
      expect(buttonLoading.textContent).toContain('Saving...');
    });

    it('exposes only the visible state via the accessible name', () => {
      const { rerender } = render(
        <ModalActions primary={{ label: 'Save', loadingLabel: 'Saving...', onClick: vi.fn() }} />
      );
      // Idle: only "Save" should match by accessible name.
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Saving...' })).not.toBeInTheDocument();

      rerender(
        <ModalActions
          primary={{
            label: 'Save',
            loadingLabel: 'Saving...',
            loading: true,
            onClick: vi.fn(),
          }}
        />
      );
      // Loading: only "Saving..." should match.
      expect(screen.getByRole('button', { name: 'Saving...' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    });

    it('marks the reservation slot aria-hidden so it does not announce', () => {
      render(
        <ModalActions primary={{ label: 'Save', loadingLabel: 'Saving...', onClick: vi.fn() }} />
      );
      const button = screen.getByRole('button');
      const reservation = button.querySelector('[data-slot="button-reservation"]');
      expect(reservation).toHaveAttribute('aria-hidden', 'true');
    });

    it('uses visibility:hidden (Tailwind .invisible) on reservation so it keeps layout', () => {
      render(
        <ModalActions primary={{ label: 'Save', loadingLabel: 'Saving...', onClick: vi.fn() }} />
      );
      const button = screen.getByRole('button');
      const reservation = button.querySelector('[data-slot="button-reservation"]')!;
      expect(reservation.className).toContain('invisible');
    });

    it('falls back to label when loadingLabel is not provided', () => {
      render(<ModalActions primary={{ label: 'Save', onClick: vi.fn() }} />);
      const button = screen.getByRole('button', { name: 'Save' });
      // Both slots still render — both contain "Save" since loadingLabel
      // defaults to label. Accessible name is the visible "Save".
      const visible = button.querySelector('[data-slot="button-visible"]')!;
      const reservation = button.querySelector('[data-slot="button-reservation"]')!;
      expect(visible.textContent).toContain('Save');
      expect(reservation.textContent).toContain('Save');
    });
  });
});
