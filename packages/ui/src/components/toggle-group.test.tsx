import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

describe('ToggleGroup', () => {
  describe('single mode', () => {
    it('renders multiple items as buttons', () => {
      render(
        <ToggleGroup type="single" aria-label="View">
          <ToggleGroupItem value="a" aria-label="View A" />
          <ToggleGroupItem value="b" aria-label="View B" />
        </ToggleGroup>
      );
      expect(screen.getAllByRole('radio')).toHaveLength(2);
    });

    it('selecting an item changes its state to on', async () => {
      const user = userEvent.setup();
      render(
        <ToggleGroup type="single" aria-label="View">
          <ToggleGroupItem value="a" aria-label="View A" />
          <ToggleGroupItem value="b" aria-label="View B" />
        </ToggleGroup>
      );

      const items = screen.getAllByRole('radio');
      await user.click(items[0]!);
      expect(items[0]).toHaveAttribute('data-state', 'on');
    });

    it('selecting one item deselects the previously selected item', async () => {
      const user = userEvent.setup();
      render(
        <ToggleGroup type="single" defaultValue="a" aria-label="View">
          <ToggleGroupItem value="a" aria-label="View A" />
          <ToggleGroupItem value="b" aria-label="View B" />
        </ToggleGroup>
      );

      const [a, b] = screen.getAllByRole('radio');
      expect(a).toHaveAttribute('data-state', 'on');

      await user.click(b!);
      expect(a).toHaveAttribute('data-state', 'off');
      expect(b).toHaveAttribute('data-state', 'on');
    });

    it('fires onValueChange in single mode', async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(
        <ToggleGroup type="single" aria-label="View" onValueChange={onValueChange}>
          <ToggleGroupItem value="a" aria-label="View A" />
          <ToggleGroupItem value="b" aria-label="View B" />
        </ToggleGroup>
      );

      await user.click(screen.getAllByRole('radio')[1]!);
      expect(onValueChange).toHaveBeenCalledWith('b');
    });

    it('respects controlled value in single mode', () => {
      const { rerender } = render(
        <ToggleGroup type="single" value="a" aria-label="View" onValueChange={() => {}}>
          <ToggleGroupItem value="a" aria-label="View A" />
          <ToggleGroupItem value="b" aria-label="View B" />
        </ToggleGroup>
      );
      expect(screen.getAllByRole('radio')[0]).toHaveAttribute('data-state', 'on');

      rerender(
        <ToggleGroup type="single" value="b" aria-label="View" onValueChange={() => {}}>
          <ToggleGroupItem value="a" aria-label="View A" />
          <ToggleGroupItem value="b" aria-label="View B" />
        </ToggleGroup>
      );
      expect(screen.getAllByRole('radio')[1]).toHaveAttribute('data-state', 'on');
    });
  });

  describe('multiple mode', () => {
    it('allows multiple items to be selected concurrently', async () => {
      const user = userEvent.setup();
      render(
        <ToggleGroup type="multiple" aria-label="Filters">
          <ToggleGroupItem value="a" aria-label="A" />
          <ToggleGroupItem value="b" aria-label="B" />
        </ToggleGroup>
      );

      const items = screen.getAllByRole('button');
      await user.click(items[0]!);
      await user.click(items[1]!);
      expect(items[0]).toHaveAttribute('data-state', 'on');
      expect(items[1]).toHaveAttribute('data-state', 'on');
    });

    it('fires onValueChange with array in multiple mode', async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(
        <ToggleGroup type="multiple" aria-label="Filters" onValueChange={onValueChange}>
          <ToggleGroupItem value="a" aria-label="A" />
          <ToggleGroupItem value="b" aria-label="B" />
        </ToggleGroup>
      );

      await user.click(screen.getAllByRole('button')[0]!);
      expect(onValueChange).toHaveBeenLastCalledWith(['a']);

      await user.click(screen.getAllByRole('button')[1]!);
      expect(onValueChange).toHaveBeenLastCalledWith(['a', 'b']);
    });

    it('respects controlled value in multiple mode', () => {
      const { rerender } = render(
        <ToggleGroup type="multiple" value={['a']} aria-label="Filters" onValueChange={() => {}}>
          <ToggleGroupItem value="a" aria-label="A" />
          <ToggleGroupItem value="b" aria-label="B" />
        </ToggleGroup>
      );
      expect(screen.getAllByRole('button')[0]).toHaveAttribute('data-state', 'on');
      expect(screen.getAllByRole('button')[1]).toHaveAttribute('data-state', 'off');

      rerender(
        <ToggleGroup
          type="multiple"
          value={['a', 'b']}
          aria-label="Filters"
          onValueChange={() => {}}
        >
          <ToggleGroupItem value="a" aria-label="A" />
          <ToggleGroupItem value="b" aria-label="B" />
        </ToggleGroup>
      );
      expect(screen.getAllByRole('button')[1]).toHaveAttribute('data-state', 'on');
    });
  });

  describe('keyboard navigation', () => {
    it('moves focus to the first item on tab when no value is set', async () => {
      const user = userEvent.setup();
      render(
        <>
          <button>before</button>
          <ToggleGroup type="single" aria-label="View">
            <ToggleGroupItem value="a" aria-label="View A" />
            <ToggleGroupItem value="b" aria-label="View B" />
          </ToggleGroup>
        </>
      );

      screen.getByText('before').focus();
      await user.tab();
      expect(screen.getAllByRole('radio')[0]).toHaveFocus();
    });

    it('toggles focused item on Space key (multiple mode)', async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(
        <ToggleGroup type="multiple" aria-label="Filters" onValueChange={onValueChange}>
          <ToggleGroupItem value="a" aria-label="A" />
        </ToggleGroup>
      );

      act(() => {
        screen.getByRole('button').focus();
      });
      await user.keyboard(' ');
      expect(onValueChange).toHaveBeenCalledWith(['a']);
    });
  });

  describe('disabled state', () => {
    it('disables the entire group when group disabled prop is true', () => {
      render(
        <ToggleGroup type="single" disabled aria-label="View">
          <ToggleGroupItem value="a" aria-label="A" />
          <ToggleGroupItem value="b" aria-label="B" />
        </ToggleGroup>
      );
      for (const item of screen.getAllByRole('radio')) {
        expect(item).toBeDisabled();
      }
    });

    it('disables individual items via item-level disabled prop', () => {
      render(
        <ToggleGroup type="single" aria-label="View">
          <ToggleGroupItem value="a" aria-label="A" />
          <ToggleGroupItem value="b" aria-label="B" disabled />
        </ToggleGroup>
      );
      const items = screen.getAllByRole('radio');
      expect(items[0]).not.toBeDisabled();
      expect(items[1]).toBeDisabled();
    });

    it('does not fire onValueChange when group is disabled', async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(
        <ToggleGroup type="single" disabled aria-label="View" onValueChange={onValueChange}>
          <ToggleGroupItem value="a" aria-label="A" />
        </ToggleGroup>
      );

      await user.click(screen.getByRole('radio'));
      expect(onValueChange).not.toHaveBeenCalled();
    });
  });

  describe('styling and props', () => {
    it('applies custom className to the root', () => {
      render(
        <ToggleGroup type="single" aria-label="View" className="custom-root" data-testid="group">
          <ToggleGroupItem value="a" aria-label="A" />
        </ToggleGroup>
      );
      expect(screen.getByTestId('group')).toHaveClass('custom-root');
    });

    it('applies custom className to an item', () => {
      render(
        <ToggleGroup type="single" aria-label="View">
          <ToggleGroupItem value="a" aria-label="A" className="custom-item" />
        </ToggleGroup>
      );
      expect(screen.getByRole('radio')).toHaveClass('custom-item');
    });

    it('has data-slot attributes for styling', () => {
      render(
        <ToggleGroup type="single" aria-label="View" data-testid="group">
          <ToggleGroupItem value="a" aria-label="A" />
        </ToggleGroup>
      );
      expect(screen.getByTestId('group')).toHaveAttribute('data-slot', 'toggle-group');
      expect(screen.getByRole('radio')).toHaveAttribute('data-slot', 'toggle-group-item');
    });

    it('forwards additional props to root and items', () => {
      render(
        <ToggleGroup type="single" aria-label="View" data-testid="my-group">
          <ToggleGroupItem value="a" aria-label="A" data-testid="my-item" />
        </ToggleGroup>
      );
      expect(screen.getByTestId('my-group')).toBeInTheDocument();
      expect(screen.getByTestId('my-item')).toBeInTheDocument();
    });

    it('supports variant via root prop', () => {
      render(
        <ToggleGroup type="single" aria-label="View" variant="outline" data-testid="group">
          <ToggleGroupItem value="a" aria-label="A" />
        </ToggleGroup>
      );
      expect(screen.getByTestId('group')).toHaveAttribute('data-variant', 'outline');
    });

    it('supports size via root prop', () => {
      render(
        <ToggleGroup type="single" aria-label="View" size="sm" data-testid="group">
          <ToggleGroupItem value="a" aria-label="A" />
        </ToggleGroup>
      );
      expect(screen.getByTestId('group')).toHaveAttribute('data-size', 'sm');
    });

    it('renders item children', () => {
      render(
        <ToggleGroup type="single" aria-label="View">
          <ToggleGroupItem value="a" aria-label="A">
            Bold
          </ToggleGroupItem>
        </ToggleGroup>
      );
      expect(screen.getByRole('radio')).toHaveTextContent('Bold');
    });
  });
});
