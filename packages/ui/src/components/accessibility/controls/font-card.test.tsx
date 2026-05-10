import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { FontCard } from './font-card';

const DEFAULT_PROPS = {
  selected: false,
  purpose: 'For low vision',
  fontName: 'Atkinson Hyperlegible',
  fontFamily: '"Atkinson Hyperlegible", system-ui',
  onSelect: vi.fn(),
};

describe('FontCard', () => {
  describe('rendering', () => {
    it('renders as a button', () => {
      render(<FontCard {...DEFAULT_PROPS} onSelect={vi.fn()} />);
      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('renders the purpose text', () => {
      render(<FontCard {...DEFAULT_PROPS} onSelect={vi.fn()} />);
      expect(screen.getByText('For low vision')).toBeInTheDocument();
    });

    it('renders the font name text', () => {
      render(<FontCard {...DEFAULT_PROPS} onSelect={vi.fn()} />);
      expect(screen.getByText('Atkinson Hyperlegible')).toBeInTheDocument();
    });

    it('applies the fontFamily style to the purpose line', () => {
      render(<FontCard {...DEFAULT_PROPS} onSelect={vi.fn()} />);
      const purpose = screen.getByText('For low vision');
      expect(purpose).toHaveStyle({ fontFamily: '"Atkinson Hyperlegible", system-ui' });
    });

    it('applies the fontFamily style to the font name line', () => {
      render(<FontCard {...DEFAULT_PROPS} onSelect={vi.fn()} />);
      const name = screen.getByText('Atkinson Hyperlegible');
      expect(name).toHaveStyle({ fontFamily: '"Atkinson Hyperlegible", system-ui' });
    });

    it('applies a custom className', () => {
      render(<FontCard {...DEFAULT_PROPS} onSelect={vi.fn()} className="custom-card" />);
      expect(screen.getByRole('button')).toHaveClass('custom-card');
    });

    it('renders an indicator marked with data-slot for selection', () => {
      render(<FontCard {...DEFAULT_PROPS} onSelect={vi.fn()} />);
      const indicator = screen
        .getByRole('button')
        .querySelector('[data-slot="font-card-indicator"]');
      expect(indicator).not.toBeNull();
    });
  });

  describe('selection state', () => {
    it('aria-pressed reflects the selected prop (false)', () => {
      render(<FontCard {...DEFAULT_PROPS} selected={false} onSelect={vi.fn()} />);
      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    });

    it('aria-pressed reflects the selected prop (true)', () => {
      render(<FontCard {...DEFAULT_PROPS} selected={true} onSelect={vi.fn()} />);
      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    });

    it('exposes data-state via the indicator slot', () => {
      const { rerender } = render(
        <FontCard {...DEFAULT_PROPS} selected={false} onSelect={vi.fn()} />
      );
      const button = screen.getByRole('button');
      expect(
        button.querySelector<HTMLElement>('[data-slot="font-card-indicator"]')?.dataset['state']
      ).toBe('off');

      rerender(<FontCard {...DEFAULT_PROPS} selected={true} onSelect={vi.fn()} />);
      expect(
        screen.getByRole('button').querySelector<HTMLElement>('[data-slot="font-card-indicator"]')
          ?.dataset['state']
      ).toBe('on');
    });

    it('exposes data-state on the root for styling', () => {
      const { rerender } = render(
        <FontCard {...DEFAULT_PROPS} selected={false} onSelect={vi.fn()} />
      );
      expect(screen.getByRole('button')).toHaveAttribute('data-state', 'off');

      rerender(<FontCard {...DEFAULT_PROPS} selected={true} onSelect={vi.fn()} />);
      expect(screen.getByRole('button')).toHaveAttribute('data-state', 'on');
    });
  });

  describe('click behavior', () => {
    it('calls onSelect when clicked', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(<FontCard {...DEFAULT_PROPS} onSelect={onSelect} />);

      await user.click(screen.getByRole('button'));
      expect(onSelect).toHaveBeenCalledOnce();
    });

    it('still calls onSelect when already selected', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(<FontCard {...DEFAULT_PROPS} selected={true} onSelect={onSelect} />);

      await user.click(screen.getByRole('button'));
      expect(onSelect).toHaveBeenCalledOnce();
    });

    it('calls onSelect via keyboard activation (Enter)', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(<FontCard {...DEFAULT_PROPS} onSelect={onSelect} />);

      screen.getByRole('button').focus();
      await user.keyboard('{Enter}');
      expect(onSelect).toHaveBeenCalledOnce();
    });

    it('calls onSelect via keyboard activation (Space)', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(<FontCard {...DEFAULT_PROPS} onSelect={onSelect} />);

      screen.getByRole('button').focus();
      await user.keyboard(' ');
      expect(onSelect).toHaveBeenCalledOnce();
    });
  });

  describe('accessibility', () => {
    it('has an accessible name combining purpose and font name', () => {
      render(<FontCard {...DEFAULT_PROPS} onSelect={vi.fn()} />);
      expect(screen.getByRole('button')).toHaveAccessibleName(
        /for low vision.*atkinson hyperlegible/i
      );
    });
  });
});
