import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PickerModeToggle } from '@/components/chat/model-selector/picker-mode-toggle';
import type { PickerMode } from '@/stores/model';

function StatefulToggle({
  orientation,
  initialMode = 'single',
}: Readonly<{
  orientation: 'horizontal' | 'vertical';
  initialMode?: PickerMode;
}>): React.JSX.Element {
  const [mode, setMode] = React.useState<PickerMode>(initialMode);
  return (
    <PickerModeToggle
      mode={mode}
      onChange={setMode}
      orientation={orientation}
      singleLabel="Talk to one model"
      multiLabel="Multiple models at once"
    />
  );
}

describe('PickerModeToggle', () => {
  it('renders both options with their labels', () => {
    render(
      <PickerModeToggle
        mode="single"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    expect(screen.getByRole('radio', { name: /talk to one model/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /multiple models at once/i })).toBeInTheDocument();
  });

  it('marks the active mode with aria-checked=true', () => {
    render(
      <PickerModeToggle
        mode="single"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    expect(screen.getByRole('radio', { name: /talk to one model/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: /multiple models at once/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('switches active state when mode prop is multi', () => {
    render(
      <PickerModeToggle
        mode="multi"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    expect(screen.getByRole('radio', { name: /multiple models at once/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: /talk to one model/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('calls onChange("multi") when the inactive multi option is clicked from single mode', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(
      <PickerModeToggle
        mode="single"
        onChange={handleChange}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    await user.click(screen.getByRole('radio', { name: /multiple models at once/i }));
    expect(handleChange).toHaveBeenCalledWith('multi');
    expect(handleChange).toHaveBeenCalledTimes(1);
  });

  it('calls onChange("single") when the inactive single option is clicked from multi mode', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(
      <PickerModeToggle
        mode="multi"
        onChange={handleChange}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    await user.click(screen.getByRole('radio', { name: /talk to one model/i }));
    expect(handleChange).toHaveBeenCalledWith('single');
  });

  it('does not call onChange when the active option is clicked again', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(
      <PickerModeToggle
        mode="single"
        onChange={handleChange}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    await user.click(screen.getByRole('radio', { name: /talk to one model/i }));
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('exposes a radiogroup role on the container', () => {
    render(
      <PickerModeToggle
        mode="single"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
  });

  it('uses orientation="horizontal" attribute when orientation prop is horizontal', () => {
    render(
      <PickerModeToggle
        mode="single"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('uses orientation="vertical" attribute when orientation prop is vertical', () => {
    render(
      <PickerModeToggle
        mode="multi"
        onChange={vi.fn()}
        orientation="vertical"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('renders ReactNode text content in the multiLabel slot (e.g. count suffix)', () => {
    render(
      <PickerModeToggle
        mode="multi"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel={
          <span>
            Multiple models at once · <span data-testid="count-suffix">3 of 5</span>
          </span>
        }
      />
    );
    expect(screen.getByText(/3 of 5/)).toBeInTheDocument();
    expect(screen.getByTestId('count-suffix')).toBeInTheDocument();
  });

  it('keyboard ArrowRight on horizontal orientation moves selection from single to multi', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(
      <PickerModeToggle
        mode="single"
        onChange={handleChange}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const single = screen.getByRole('radio', { name: /talk to one model/i });
    single.focus();
    await user.keyboard('{ArrowRight}');
    expect(handleChange).toHaveBeenCalledWith('multi');
  });

  it('keyboard ArrowDown on vertical orientation moves selection from single to multi', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(
      <PickerModeToggle
        mode="single"
        onChange={handleChange}
        orientation="vertical"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const single = screen.getByRole('radio', { name: /talk to one model/i });
    single.focus();
    await user.keyboard('{ArrowDown}');
    expect(handleChange).toHaveBeenCalledWith('multi');
  });

  it('keyboard ArrowLeft on horizontal orientation moves selection from multi to single', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(
      <PickerModeToggle
        mode="multi"
        onChange={handleChange}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const multi = screen.getByRole('radio', { name: /multiple models at once/i });
    multi.focus();
    await user.keyboard('{ArrowLeft}');
    expect(handleChange).toHaveBeenCalledWith('single');
  });

  it('keyboard ArrowUp on vertical orientation moves selection from multi to single', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(
      <PickerModeToggle
        mode="multi"
        onChange={handleChange}
        orientation="vertical"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const multi = screen.getByRole('radio', { name: /multiple models at once/i });
    multi.focus();
    await user.keyboard('{ArrowUp}');
    expect(handleChange).toHaveBeenCalledWith('single');
  });

  it('ArrowLeft on the single option (horizontal) is a no-op', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(
      <PickerModeToggle
        mode="single"
        onChange={handleChange}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const single = screen.getByRole('radio', { name: /talk to one model/i });
    single.focus();
    await user.keyboard('{ArrowLeft}');
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('ArrowUp on the single option (vertical) is a no-op', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(
      <PickerModeToggle
        mode="single"
        onChange={handleChange}
        orientation="vertical"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const single = screen.getByRole('radio', { name: /talk to one model/i });
    single.focus();
    await user.keyboard('{ArrowUp}');
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('ArrowRight on the multi option (horizontal) is a no-op', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(
      <PickerModeToggle
        mode="multi"
        onChange={handleChange}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const multi = screen.getByRole('radio', { name: /multiple models at once/i });
    multi.focus();
    await user.keyboard('{ArrowRight}');
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('ArrowDown on the multi option (vertical) is a no-op', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(
      <PickerModeToggle
        mode="multi"
        onChange={handleChange}
        orientation="vertical"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const multi = screen.getByRole('radio', { name: /multiple models at once/i });
    multi.focus();
    await user.keyboard('{ArrowDown}');
    expect(handleChange).not.toHaveBeenCalled();
  });

  it.each([
    ['horizontal', '{ArrowRight}', '{ArrowLeft}'],
    ['vertical', '{ArrowDown}', '{ArrowUp}'],
  ] as const)(
    'moves focus to the newly selected option on each arrow key (%s), from single to multi then back',
    async (orientation, towardsMulti, towardsSingle) => {
      const user = userEvent.setup();
      render(<StatefulToggle orientation={orientation} />);
      const single = screen.getByRole('radio', { name: /talk to one model/i });
      const multi = screen.getByRole('radio', { name: /multiple models at once/i });
      single.focus();

      await user.keyboard(towardsMulti);
      expect(multi).toHaveAttribute('aria-checked', 'true');
      expect(multi).toHaveFocus();

      await user.keyboard(towardsSingle);
      expect(single).toHaveAttribute('aria-checked', 'true');
      expect(single).toHaveFocus();
    }
  );

  it('gives focus to the option an arrow key selects only once it reads as checked', async () => {
    const user = userEvent.setup();
    render(<StatefulToggle orientation="horizontal" />);
    const single = screen.getByRole('radio', { name: /talk to one model/i });
    const multi = screen.getByRole('radio', { name: /multiple models at once/i });
    const checkedOnFocus: (string | null)[] = [];
    multi.addEventListener('focus', () => {
      checkedOnFocus.push(multi.getAttribute('aria-checked'));
    });
    single.focus();

    await user.keyboard('{ArrowRight}');

    expect(checkedOnFocus).toEqual(['true']);
  });

  it.each([
    ['single', /multiple models at once/i, '{ArrowLeft}'],
    ['multi', /talk to one model/i, '{ArrowRight}'],
  ] as const)(
    'leaves focus on the clicked option when an arrow press before the click changed nothing (from %s)',
    async (initialMode, unselectedName, arrowToSelected) => {
      const user = userEvent.setup();
      render(<StatefulToggle orientation="horizontal" initialMode={initialMode} />);
      const unselected = screen.getByRole('radio', { name: unselectedName });
      unselected.focus();
      await user.keyboard(arrowToSelected);

      await user.click(unselected);

      expect(unselected).toHaveAttribute('aria-checked', 'true');
      expect(unselected).toHaveFocus();
    }
  );

  it('leaves focus where it is when the mode changes without an arrow key', () => {
    const renderWithMode = (mode: PickerMode): React.JSX.Element => (
      <>
        <button type="button">Elsewhere</button>
        <PickerModeToggle
          mode={mode}
          onChange={vi.fn()}
          orientation="horizontal"
          singleLabel="Talk to one model"
          multiLabel="Multiple models at once"
        />
      </>
    );
    const { rerender } = render(renderWithMode('single'));
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();

    rerender(renderWithMode('multi'));

    expect(elsewhere).toHaveFocus();
  });

  it.each([
    ['single', /talk to one model/i],
    ['multi', /multiple models at once/i],
  ])("hides the %s option's browser outline only while it has keyboard focus", (_, name) => {
    render(
      <PickerModeToggle
        mode="single"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const option = screen.getByRole('radio', { name });
    const suppressions = [...option.classList].filter((token) =>
      /(^|:)outline-(none|hidden)$/.test(token)
    );
    expect(suppressions).toEqual(['focus-visible:outline-hidden']);
  });

  it('renders the active-state pill indicator with data-active=true on the active option', () => {
    render(
      <PickerModeToggle
        mode="multi"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const multi = screen.getByRole('radio', { name: /multiple models at once/i });
    expect(multi).toHaveAttribute('data-active', 'true');
    const single = screen.getByRole('radio', { name: /talk to one model/i });
    expect(single).toHaveAttribute('data-active', 'false');
  });

  it("fills the selected option's pill with the Highlight system colour under forced colors", () => {
    render(
      <PickerModeToggle
        mode="multi"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const multi = screen.getByRole('radio', { name: /multiple models at once/i });
    const pill = multi.querySelector(':scope > [aria-hidden="true"]');
    expect(pill?.classList).toContain('forced-colors:bg-[Highlight]');
  });

  it("sets the selected option's label in HighlightText under forced colors", () => {
    render(
      <PickerModeToggle
        mode="multi"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    expect(screen.getByText('Multiple models at once').classList).toContain(
      'forced-colors:text-[HighlightText]'
    );
  });

  it("lifts only the selected option's label out of forced-colour adjustment", () => {
    render(
      <PickerModeToggle
        mode="multi"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const optedOut = [...screen.getByTestId('picker-mode-toggle').querySelectorAll('*')].filter(
      (element) => element.classList.contains('forced-color-adjust-none')
    );
    expect(optedOut).toEqual([screen.getByText('Multiple models at once')]);
  });

  it("leaves the unselected option's label in the forced palette's own text colour", () => {
    render(
      <PickerModeToggle
        mode="multi"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const single = screen.getByRole('radio', { name: /talk to one model/i });
    const forcedTokens = [single, ...single.querySelectorAll('*')].flatMap((element) =>
      [...element.classList].filter((token) => token.startsWith('forced-colors:'))
    );
    expect(forcedTokens).toEqual([]);
  });

  it('shows a pointer cursor on the inactive option', () => {
    render(
      <PickerModeToggle
        mode="single"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const multi = screen.getByRole('radio', { name: /multiple models at once/i });
    expect(multi.className).toContain('cursor-pointer');
  });

  it('does not show a pointer cursor on the active option', () => {
    render(
      <PickerModeToggle
        mode="single"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    const single = screen.getByRole('radio', { name: /talk to one model/i });
    expect(single.className).not.toContain('cursor-pointer');
  });

  it('exposes a stable testid for the toggle root', () => {
    render(
      <PickerModeToggle
        mode="single"
        onChange={vi.fn()}
        orientation="horizontal"
        singleLabel="Talk to one model"
        multiLabel="Multiple models at once"
      />
    );
    expect(screen.getByTestId('picker-mode-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('picker-mode-single')).toBeInTheDocument();
    expect(screen.getByTestId('picker-mode-multi')).toBeInTheDocument();
  });
});
