import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { RadioGroup, RadioGroupItem } from './radio-group';

function renderGroup(
  props: React.ComponentProps<typeof RadioGroup> & Record<`data-${string}`, string> = {}
) {
  return render(
    <RadioGroup aria-label="Choice" {...props}>
      <RadioGroupItem value="a" aria-label="Option A" />
      <RadioGroupItem value="b" aria-label="Option B" />
      <RadioGroupItem value="c" aria-label="Option C" />
    </RadioGroup>
  );
}

describe('RadioGroup', () => {
  it('renders multiple items as radio inputs', () => {
    renderGroup();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('renders with the radiogroup role on the root', () => {
    renderGroup({ 'data-testid': 'group' });
    expect(screen.getByTestId('group')).toHaveAttribute('role', 'radiogroup');
  });

  it('selecting one item via click sets only that item to checked', async () => {
    const user = userEvent.setup();
    renderGroup();
    const [a, b, c] = screen.getAllByRole('radio');

    await user.click(b!);
    expect(a).toHaveAttribute('data-state', 'unchecked');
    expect(b).toHaveAttribute('data-state', 'checked');
    expect(c).toHaveAttribute('data-state', 'unchecked');
  });

  it('selecting another item deselects the previous selection', async () => {
    const user = userEvent.setup();
    renderGroup({ defaultValue: 'a' });
    const [a, b] = screen.getAllByRole('radio');
    expect(a).toHaveAttribute('data-state', 'checked');

    await user.click(b!);
    expect(a).toHaveAttribute('data-state', 'unchecked');
    expect(b).toHaveAttribute('data-state', 'checked');
  });

  it('fires onValueChange when selection changes', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup aria-label="Choice" onValueChange={onValueChange}>
        <RadioGroupItem value="a" aria-label="Option A" />
        <RadioGroupItem value="b" aria-label="Option B" />
      </RadioGroup>
    );

    await user.click(screen.getAllByRole('radio')[1]!);
    expect(onValueChange).toHaveBeenCalledWith('b');
  });

  it('supports controlled value', () => {
    const { rerender } = render(
      <RadioGroup aria-label="Choice" value="a" onValueChange={() => {}}>
        <RadioGroupItem value="a" aria-label="Option A" />
        <RadioGroupItem value="b" aria-label="Option B" />
      </RadioGroup>
    );
    expect(screen.getAllByRole('radio')[0]).toHaveAttribute('data-state', 'checked');

    rerender(
      <RadioGroup aria-label="Choice" value="b" onValueChange={() => {}}>
        <RadioGroupItem value="a" aria-label="Option A" />
        <RadioGroupItem value="b" aria-label="Option B" />
      </RadioGroup>
    );
    expect(screen.getAllByRole('radio')[1]).toHaveAttribute('data-state', 'checked');
  });

  it('selects the focused item when activated via Space key', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup aria-label="Choice" onValueChange={onValueChange}>
        <RadioGroupItem value="a" aria-label="Option A" />
        <RadioGroupItem value="b" aria-label="Option B" />
        <RadioGroupItem value="c" aria-label="Option C" />
      </RadioGroup>
    );

    const [, b] = screen.getAllByRole('radio');
    act(() => {
      b!.focus();
    });
    await user.keyboard(' ');
    expect(onValueChange).toHaveBeenCalledWith('b');
  });

  it('focuses the first item on Tab when no value is set', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button>before</button>
        <RadioGroup aria-label="Choice">
          <RadioGroupItem value="a" aria-label="Option A" />
          <RadioGroupItem value="b" aria-label="Option B" />
        </RadioGroup>
      </>
    );

    screen.getByText('before').focus();
    await user.tab();
    // First radio receives focus per RovingFocus convention
    expect(screen.getAllByRole('radio')[0]).toHaveFocus();
  });

  it('disables the entire group when disabled prop is true', () => {
    renderGroup({ disabled: true });
    for (const item of screen.getAllByRole('radio')) {
      expect(item).toBeDisabled();
    }
  });

  it('disables individual items via item-level disabled prop', () => {
    render(
      <RadioGroup aria-label="Choice">
        <RadioGroupItem value="a" aria-label="Option A" />
        <RadioGroupItem value="b" aria-label="Option B" disabled />
      </RadioGroup>
    );
    const items = screen.getAllByRole('radio');
    expect(items[0]).not.toBeDisabled();
    expect(items[1]).toBeDisabled();
  });

  it('does not fire onValueChange when group is disabled', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup aria-label="Choice" disabled onValueChange={onValueChange}>
        <RadioGroupItem value="a" aria-label="Option A" />
        <RadioGroupItem value="b" aria-label="Option B" />
      </RadioGroup>
    );

    await user.click(screen.getAllByRole('radio')[1]!);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('applies custom className to the root', () => {
    render(
      <RadioGroup aria-label="Choice" className="custom-root" data-testid="group">
        <RadioGroupItem value="a" aria-label="Option A" />
      </RadioGroup>
    );
    expect(screen.getByTestId('group')).toHaveClass('custom-root');
  });

  it('applies custom className to an item', () => {
    render(
      <RadioGroup aria-label="Choice">
        <RadioGroupItem value="a" aria-label="Option A" className="custom-item" />
      </RadioGroup>
    );
    expect(screen.getByRole('radio')).toHaveClass('custom-item');
  });

  it('has data-slot attributes for styling', () => {
    render(
      <RadioGroup aria-label="Choice" data-testid="group">
        <RadioGroupItem value="a" aria-label="Option A" />
      </RadioGroup>
    );
    expect(screen.getByTestId('group')).toHaveAttribute('data-slot', 'radio-group');
    expect(screen.getByRole('radio')).toHaveAttribute('data-slot', 'radio-group-item');
  });

  it('renders a checked indicator when an item is checked', () => {
    render(
      <RadioGroup aria-label="Choice" defaultValue="a">
        <RadioGroupItem value="a" aria-label="Option A" />
      </RadioGroup>
    );
    expect(
      screen.getByRole('radio').querySelector('[data-slot="radio-group-indicator"]')
    ).not.toBeNull();
  });

  it('forwards additional props to the root', () => {
    render(
      <RadioGroup aria-label="Choice" data-testid="my-group">
        <RadioGroupItem value="a" aria-label="Option A" />
      </RadioGroup>
    );
    expect(screen.getByTestId('my-group')).toBeInTheDocument();
  });

  it('forwards additional props to items', () => {
    render(
      <RadioGroup aria-label="Choice">
        <RadioGroupItem value="a" aria-label="Option A" data-testid="my-item" />
      </RadioGroup>
    );
    expect(screen.getByTestId('my-item')).toBeInTheDocument();
  });
});
