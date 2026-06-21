import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PickerModeToggle } from '@/components/chat/model-selector/picker-mode-toggle';

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
