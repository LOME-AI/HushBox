import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { CycleButton } from './cycle-button';

const THEME_VALUES = ['light', 'dark', 'system'] as const;

describe('CycleButton', () => {
  describe('rendering', () => {
    it('renders as a button', () => {
      render(<CycleButton label="Theme" values={THEME_VALUES} value="light" onChange={vi.fn()} />);
      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('renders the label and current value', () => {
      render(<CycleButton label="Theme" values={THEME_VALUES} value="dark" onChange={vi.fn()} />);
      const button = screen.getByRole('button');
      expect(button).toHaveTextContent('Theme');
      expect(button).toHaveTextContent('dark');
    });

    it('renders the cycle icon', () => {
      render(<CycleButton label="Theme" values={THEME_VALUES} value="light" onChange={vi.fn()} />);
      // RotateCw icon from lucide renders an svg
      const svg = screen.getByRole('button').querySelector('svg');
      expect(svg).not.toBeNull();
    });

    it('uses formatValue when provided', () => {
      const formatValue = (v: (typeof THEME_VALUES)[number]): string =>
        v.charAt(0).toUpperCase() + v.slice(1);
      render(
        <CycleButton
          label="Theme"
          values={THEME_VALUES}
          value="dark"
          onChange={vi.fn()}
          formatValue={formatValue}
        />
      );
      expect(screen.getByRole('button')).toHaveTextContent('Dark');
    });

    it('falls back to identity formatting when formatValue is not provided', () => {
      render(<CycleButton label="Theme" values={THEME_VALUES} value="system" onChange={vi.fn()} />);
      expect(screen.getByRole('button')).toHaveTextContent('system');
    });

    it('applies custom className', () => {
      render(
        <CycleButton
          label="Theme"
          values={THEME_VALUES}
          value="light"
          onChange={vi.fn()}
          className="custom-class"
        />
      );
      expect(screen.getByRole('button')).toHaveClass('custom-class');
    });
  });

  describe('aria-label', () => {
    it('combines label and current formatted value', () => {
      render(<CycleButton label="Theme" values={THEME_VALUES} value="dark" onChange={vi.fn()} />);
      expect(screen.getByRole('button')).toHaveAccessibleName(/theme.*dark/i);
    });

    it('uses formatted value in aria-label when formatValue is provided', () => {
      render(
        <CycleButton
          label="Theme"
          values={THEME_VALUES}
          value="dark"
          onChange={vi.fn()}
          formatValue={(v) => v.toUpperCase()}
        />
      );
      expect(screen.getByRole('button')).toHaveAccessibleName(/Theme.*DARK/);
    });
  });

  describe('click behavior', () => {
    it('cycles forward to next value on click', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<CycleButton label="Theme" values={THEME_VALUES} value="light" onChange={onChange} />);

      await user.click(screen.getByRole('button'));
      expect(onChange).toHaveBeenCalledWith('dark');
    });

    it('wraps to first value when clicking on last value', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <CycleButton label="Theme" values={THEME_VALUES} value="system" onChange={onChange} />
      );

      await user.click(screen.getByRole('button'));
      expect(onChange).toHaveBeenCalledWith('light');
    });

    it('cycles to next value (middle case)', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<CycleButton label="Theme" values={THEME_VALUES} value="dark" onChange={onChange} />);

      await user.click(screen.getByRole('button'));
      expect(onChange).toHaveBeenCalledWith('system');
    });

    it('falls back to first value when current value is not in the list', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <CycleButton
          label="Theme"
          values={THEME_VALUES}
          // simulate stale value not present in the list
          value={'unknown' as (typeof THEME_VALUES)[number]}
          onChange={onChange}
        />
      );

      await user.click(screen.getByRole('button'));
      expect(onChange).toHaveBeenCalledWith('light');
    });
  });

  describe('keyboard navigation', () => {
    it('cycles forward on Space key', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<CycleButton label="Theme" values={THEME_VALUES} value="light" onChange={onChange} />);

      act(() => {
        screen.getByRole('button').focus();
      });
      await user.keyboard(' ');
      expect(onChange).toHaveBeenCalledWith('dark');
    });

    it('cycles forward on Enter key', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<CycleButton label="Theme" values={THEME_VALUES} value="light" onChange={onChange} />);

      act(() => {
        screen.getByRole('button').focus();
      });
      await user.keyboard('{Enter}');
      expect(onChange).toHaveBeenCalledWith('dark');
    });

    it('cycles forward on ArrowRight key', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<CycleButton label="Theme" values={THEME_VALUES} value="light" onChange={onChange} />);

      act(() => {
        screen.getByRole('button').focus();
      });
      await user.keyboard('{ArrowRight}');
      expect(onChange).toHaveBeenCalledWith('dark');
    });

    it('cycles backward on ArrowLeft key', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<CycleButton label="Theme" values={THEME_VALUES} value="dark" onChange={onChange} />);

      act(() => {
        screen.getByRole('button').focus();
      });
      await user.keyboard('{ArrowLeft}');
      expect(onChange).toHaveBeenCalledWith('light');
    });

    it('wraps to last value when ArrowLeft on first value', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<CycleButton label="Theme" values={THEME_VALUES} value="light" onChange={onChange} />);

      act(() => {
        screen.getByRole('button').focus();
      });
      await user.keyboard('{ArrowLeft}');
      expect(onChange).toHaveBeenCalledWith('system');
    });

    it('jumps to first value on Home key', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<CycleButton label="Theme" values={THEME_VALUES} value="dark" onChange={onChange} />);

      act(() => {
        screen.getByRole('button').focus();
      });
      await user.keyboard('{Home}');
      expect(onChange).toHaveBeenCalledWith('light');
    });

    it('jumps to last value on End key', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<CycleButton label="Theme" values={THEME_VALUES} value="light" onChange={onChange} />);

      act(() => {
        screen.getByRole('button').focus();
      });
      await user.keyboard('{End}');
      expect(onChange).toHaveBeenCalledWith('system');
    });

    it('does not call onChange for unrelated keys', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<CycleButton label="Theme" values={THEME_VALUES} value="light" onChange={onChange} />);

      act(() => {
        screen.getByRole('button').focus();
      });
      await user.keyboard('a');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('falls back to last value when ArrowLeft pressed with stale value', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <CycleButton
          label="Theme"
          values={THEME_VALUES}
          value={'unknown' as (typeof THEME_VALUES)[number]}
          onChange={onChange}
        />
      );

      act(() => {
        screen.getByRole('button').focus();
      });
      await user.keyboard('{ArrowLeft}');
      expect(onChange).toHaveBeenCalledWith('system');
    });
  });

  describe('layout stability', () => {
    it('renders hidden ghost text for each value to fix min-width', () => {
      render(<CycleButton label="Theme" values={THEME_VALUES} value="light" onChange={vi.fn()} />);
      // ghost element should contain the longest value text so the layout doesn't shift.
      const ghosts = screen
        .getByRole('button')
        .querySelectorAll('[data-slot="cycle-button-ghost"]');
      expect(ghosts.length).toBe(THEME_VALUES.length);
    });

    it('renders hidden ghosts using formatValue when provided', () => {
      render(
        <CycleButton
          label="Theme"
          values={THEME_VALUES}
          value="light"
          onChange={vi.fn()}
          formatValue={(v) => v.toUpperCase()}
        />
      );
      const button = screen.getByRole('button');
      const ghosts = button.querySelectorAll('[data-slot="cycle-button-ghost"]');
      const text = [...ghosts].map((g) => g.textContent);
      expect(text).toEqual(['LIGHT', 'DARK', 'SYSTEM']);
    });
  });
});
