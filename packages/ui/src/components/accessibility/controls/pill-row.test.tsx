import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { PillRow } from './pill-row';

const COLOR_BLIND_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'protan', label: 'Protan' },
  { value: 'deutan', label: 'Deutan' },
  { value: 'tritan', label: 'Tritan' },
] as const;

type ColorBlindValue = (typeof COLOR_BLIND_OPTIONS)[number]['value'];

describe('PillRow', () => {
  describe('rendering', () => {
    it('renders as a radiogroup', () => {
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="none"
          onChange={vi.fn()}
          ariaLabel="Color blindness"
        />
      );
      expect(screen.getByRole('radiogroup', { name: 'Color blindness' })).toBeInTheDocument();
    });

    it('renders one button per option', () => {
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="none"
          onChange={vi.fn()}
          ariaLabel="Color blindness"
        />
      );
      expect(screen.getAllByRole('radio')).toHaveLength(COLOR_BLIND_OPTIONS.length);
    });

    it('renders option labels', () => {
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="none"
          onChange={vi.fn()}
          ariaLabel="Color blindness"
        />
      );
      for (const opt of COLOR_BLIND_OPTIONS) {
        expect(screen.getByRole('radio', { name: opt.label })).toBeInTheDocument();
      }
    });

    it('applies custom className to the root', () => {
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="none"
          onChange={vi.fn()}
          ariaLabel="Color blindness"
          className="custom-row"
        />
      );
      expect(screen.getByRole('radiogroup')).toHaveClass('custom-row');
    });

    it('omits aria-label on the root when ariaLabel is not provided', () => {
      render(<PillRow options={COLOR_BLIND_OPTIONS} value="none" onChange={vi.fn()} />);
      expect(screen.getByRole('radiogroup')).not.toHaveAttribute('aria-label');
    });
  });

  describe('selection state', () => {
    it('marks the selected pill with aria-checked=true', () => {
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="protan"
          onChange={vi.fn()}
          ariaLabel="Color blindness"
        />
      );
      expect(screen.getByRole('radio', { name: 'Protan' })).toHaveAttribute('aria-checked', 'true');
    });

    it('marks unselected pills with aria-checked=false', () => {
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="protan"
          onChange={vi.fn()}
          ariaLabel="Color blindness"
        />
      );
      expect(screen.getByRole('radio', { name: 'None' })).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByRole('radio', { name: 'Deutan' })).toHaveAttribute(
        'aria-checked',
        'false'
      );
    });

    it('exposes selected state via data-state for styling', () => {
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="protan"
          onChange={vi.fn()}
          ariaLabel="Color blindness"
        />
      );
      expect(screen.getByRole('radio', { name: 'Protan' })).toHaveAttribute('data-state', 'on');
      expect(screen.getByRole('radio', { name: 'None' })).toHaveAttribute('data-state', 'off');
    });
  });

  describe('click behavior', () => {
    it('calls onChange with the clicked option value', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(next: ColorBlindValue) => void>();
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="none"
          onChange={onChange}
          ariaLabel="Color blindness"
        />
      );

      await user.click(screen.getByRole('radio', { name: 'Deutan' }));
      expect(onChange).toHaveBeenCalledWith('deutan');
    });

    it('still calls onChange even when clicking the already-selected pill', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(next: ColorBlindValue) => void>();
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="none"
          onChange={onChange}
          ariaLabel="Color blindness"
        />
      );

      await user.click(screen.getByRole('radio', { name: 'None' }));
      expect(onChange).toHaveBeenCalledWith('none');
    });
  });

  describe('keyboard navigation', () => {
    it('moves selection right with ArrowRight', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(next: ColorBlindValue) => void>();
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="none"
          onChange={onChange}
          ariaLabel="Color blindness"
        />
      );

      act(() => {
        screen.getByRole('radio', { name: 'None' }).focus();
      });
      await user.keyboard('{ArrowRight}');
      expect(onChange).toHaveBeenCalledWith('protan');
    });

    it('moves selection left with ArrowLeft', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(next: ColorBlindValue) => void>();
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="protan"
          onChange={onChange}
          ariaLabel="Color blindness"
        />
      );

      act(() => {
        screen.getByRole('radio', { name: 'Protan' }).focus();
      });
      await user.keyboard('{ArrowLeft}');
      expect(onChange).toHaveBeenCalledWith('none');
    });

    it('wraps to first when ArrowRight on last', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(next: ColorBlindValue) => void>();
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="tritan"
          onChange={onChange}
          ariaLabel="Color blindness"
        />
      );

      act(() => {
        screen.getByRole('radio', { name: 'Tritan' }).focus();
      });
      await user.keyboard('{ArrowRight}');
      expect(onChange).toHaveBeenCalledWith('none');
    });

    it('wraps to last when ArrowLeft on first', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(next: ColorBlindValue) => void>();
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="none"
          onChange={onChange}
          ariaLabel="Color blindness"
        />
      );

      act(() => {
        screen.getByRole('radio', { name: 'None' }).focus();
      });
      await user.keyboard('{ArrowLeft}');
      expect(onChange).toHaveBeenCalledWith('tritan');
    });

    it('selects focused pill on Space', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(next: ColorBlindValue) => void>();
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="none"
          onChange={onChange}
          ariaLabel="Color blindness"
        />
      );

      act(() => {
        screen.getByRole('radio', { name: 'Deutan' }).focus();
      });
      await user.keyboard(' ');
      expect(onChange).toHaveBeenCalledWith('deutan');
    });

    it('selects focused pill on Enter', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(next: ColorBlindValue) => void>();
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="none"
          onChange={onChange}
          ariaLabel="Color blindness"
        />
      );

      act(() => {
        screen.getByRole('radio', { name: 'Tritan' }).focus();
      });
      await user.keyboard('{Enter}');
      expect(onChange).toHaveBeenCalledWith('tritan');
    });

    it('falls back to first when ArrowRight pressed with stale value', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(next: ColorBlindValue) => void>();
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value={'unknown' as ColorBlindValue}
          onChange={onChange}
          ariaLabel="Color blindness"
        />
      );

      act(() => {
        screen.getByRole('radio', { name: 'None' }).focus();
      });
      await user.keyboard('{ArrowRight}');
      expect(onChange).toHaveBeenCalledWith('none');
    });

    it('does nothing on unrelated keys', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(next: ColorBlindValue) => void>();
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="none"
          onChange={onChange}
          ariaLabel="Color blindness"
        />
      );

      act(() => {
        screen.getByRole('radio', { name: 'None' }).focus();
      });
      await user.keyboard('a');
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('roving tabindex', () => {
    it('marks the selected pill with tabindex=0 and others with tabindex=-1', () => {
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value="protan"
          onChange={vi.fn()}
          ariaLabel="Color blindness"
        />
      );
      const protan = screen.getByRole('radio', { name: 'Protan' });
      const none = screen.getByRole('radio', { name: 'None' });
      expect(protan).toHaveAttribute('tabindex', '0');
      expect(none).toHaveAttribute('tabindex', '-1');
    });

    it('falls back to making the first pill focusable when value is not in the list', () => {
      render(
        <PillRow
          options={COLOR_BLIND_OPTIONS}
          value={'unknown' as ColorBlindValue}
          onChange={vi.fn()}
          ariaLabel="Color blindness"
        />
      );
      const none = screen.getByRole('radio', { name: 'None' });
      expect(none).toHaveAttribute('tabindex', '0');
    });
  });
});
