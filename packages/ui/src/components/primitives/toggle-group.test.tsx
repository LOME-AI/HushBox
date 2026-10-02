import * as React from 'react';
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

  describe('arrow keys in single mode', () => {
    function renderViews(onValueChange: (value: string) => void, value?: string): HTMLElement[] {
      render(
        <ToggleGroup
          type="single"
          aria-label="View"
          {...(value === undefined ? {} : { value })}
          onValueChange={onValueChange}
        >
          <ToggleGroupItem value="a">A</ToggleGroupItem>
          <ToggleGroupItem value="b">B</ToggleGroupItem>
          <ToggleGroupItem value="c">C</ToggleGroupItem>
        </ToggleGroup>
      );
      return screen.getAllByRole('radio');
    }

    function focus(element: HTMLElement | undefined): void {
      if (element === undefined) throw new Error('no item to focus');
      act(() => {
        element.focus();
      });
    }

    it('checks the item ArrowRight moves focus to', async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      const items = renderViews(onValueChange);

      focus(items[0]);
      await user.keyboard('{ArrowRight}');

      expect(items[1]).toHaveFocus();
      expect(items[1]).toHaveAttribute('aria-checked', 'true');
      expect(onValueChange).toHaveBeenCalledExactlyOnceWith('b');
    });

    it('checks the item ArrowLeft moves focus to, wrapping from the first to the last', async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      const items = renderViews(onValueChange);

      focus(items[0]);
      await user.keyboard('{ArrowLeft}');

      expect(items[2]).toHaveFocus();
      expect(onValueChange).toHaveBeenCalledExactlyOnceWith('c');
    });

    it('checks the item ArrowDown moves focus to', async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      const items = renderViews(onValueChange);

      focus(items[0]);
      await user.keyboard('{ArrowDown}');

      expect(onValueChange).toHaveBeenCalledExactlyOnceWith('b');
    });

    it('calls onValueChange once for each arrow move', async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      const items = renderViews(onValueChange);

      focus(items[0]);
      await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');

      expect(onValueChange.mock.calls).toEqual([['b'], ['c'], ['a']]);
    });

    it('leaves an item checked when focus arrives on it already checked', async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      const items = renderViews(onValueChange, 'b');

      focus(items[0]);
      await user.keyboard('{ArrowRight}');

      expect(items[1]).toHaveAttribute('aria-checked', 'true');
      expect(onValueChange).not.toHaveBeenCalled();
    });

    it('checks nothing when an arrow key cannot move focus off a lone item', async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(
        <ToggleGroup type="single" aria-label="View" onValueChange={onValueChange}>
          <ToggleGroupItem value="a">A</ToggleGroupItem>
        </ToggleGroup>
      );

      focus(screen.getByRole('radio'));
      await user.keyboard('{ArrowRight}');

      expect(onValueChange).not.toHaveBeenCalled();
    });

    it('checks nothing when focus leaves the group before the arrow move lands', async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(
        <>
          <button>outside</button>
          <ToggleGroup
            type="single"
            aria-label="View"
            onValueChange={onValueChange}
            onKeyDown={() => {
              setTimeout(() => {
                screen.getByText('outside').focus();
              });
            }}
          >
            <ToggleGroupItem value="a">A</ToggleGroupItem>
            <ToggleGroupItem value="b">B</ToggleGroupItem>
          </ToggleGroup>
        </>
      );

      focus(screen.getAllByRole('radio')[0]);
      await user.keyboard('{ArrowRight}');

      expect(screen.getByText('outside')).toHaveFocus();
      expect(onValueChange).not.toHaveBeenCalled();
    });

    it("calls the caller's own onKeyDown", async () => {
      const user = userEvent.setup();
      const onKeyDown = vi.fn();
      render(
        <ToggleGroup type="single" aria-label="View" onKeyDown={onKeyDown}>
          <ToggleGroupItem value="a">A</ToggleGroupItem>
        </ToggleGroup>
      );

      focus(screen.getByRole('radio'));
      await user.keyboard('{ArrowRight}');

      expect(onKeyDown).toHaveBeenCalledOnce();
    });

    it.each([
      ['Space', ' '],
      ['Enter', '{Enter}'],
    ])('checks the focused item on %s', async (_name, key) => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      const items = renderViews(onValueChange);

      focus(items[1]);
      await user.keyboard(key);

      expect(onValueChange).toHaveBeenCalledExactlyOnceWith('b');
    });

    it('moves focus without pressing anything in a multiple group', async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(
        <ToggleGroup type="multiple" aria-label="Filters" onValueChange={onValueChange}>
          <ToggleGroupItem value="a">A</ToggleGroupItem>
          <ToggleGroupItem value="b">B</ToggleGroupItem>
        </ToggleGroup>
      );
      const items = screen.getAllByRole('button');

      focus(items[0]);
      await user.keyboard('{ArrowRight}');

      expect(items[1]).toHaveFocus();
      expect(items[1]).toHaveAttribute('aria-pressed', 'false');
      expect(onValueChange).not.toHaveBeenCalled();
    });

    /**
     * The member dialogs' privilege picker as they wire it: a controlled outline group
     * whose value is the privilege the dialog sends, starting where each dialog starts.
     */
    function PrivilegePicker({
      choices,
      initial,
      onSend,
    }: Readonly<{
      choices: readonly string[];
      initial: string;
      onSend: (privilege: string) => void;
    }>): React.JSX.Element {
      const [privilege, setPrivilege] = React.useState(initial);
      return (
        <>
          <ToggleGroup
            type="single"
            variant="outline"
            className="w-full"
            aria-label="Privilege"
            value={privilege}
            onValueChange={(value) => {
              if (value) setPrivilege(value);
            }}
          >
            {choices.map((choice) => (
              <ToggleGroupItem key={choice} value={choice}>
                {choice}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <button
            onClick={() => {
              onSend(privilege);
            }}
          >
            Send
          </button>
        </>
      );
    }

    it.each([
      {
        dialog: 'Add Member',
        choices: ['read', 'write', 'admin'],
        initial: 'write',
        keys: '{ArrowRight}',
        sent: 'admin',
      },
      {
        dialog: 'Add Member',
        choices: ['read', 'write', 'admin'],
        initial: 'write',
        keys: '{ArrowLeft}{ArrowLeft}',
        sent: 'admin',
      },
      {
        dialog: 'Invite',
        choices: ['read', 'write'],
        initial: 'read',
        keys: '{ArrowRight}',
        sent: 'write',
      },
      {
        dialog: 'Invite',
        choices: ['read', 'write'],
        initial: 'read',
        keys: '{ArrowLeft}',
        sent: 'write',
      },
    ])(
      'the $dialog dialog sends $sent after $keys from $initial',
      async ({ choices, initial, keys, sent }) => {
        const user = userEvent.setup();
        const onSend = vi.fn();
        render(<PrivilegePicker choices={choices} initial={initial} onSend={onSend} />);

        focus(screen.getByRole('radio', { name: initial }));
        await user.keyboard(keys);
        await user.click(screen.getByRole('button', { name: 'Send' }));

        expect(onSend).toHaveBeenCalledExactlyOnceWith(sent);
      }
    );
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

  describe('item width', () => {
    // The test environment applies no stylesheet, so the floor is asserted as the
    // class that carries it rather than as a measured box.
    it('floors an item at its own content width so a long label cannot overflow its box', () => {
      render(
        <ToggleGroup type="single" aria-label="Show">
          <ToggleGroupItem value="both">Heat and counts</ToggleGroupItem>
          <ToggleGroupItem value="heat">Heat</ToggleGroupItem>
          <ToggleGroupItem value="counts">Counts</ToggleGroupItem>
        </ToggleGroup>
      );

      for (const item of screen.getAllByRole('radio')) {
        expect(item).toHaveClass('min-w-fit');
        expect(item.className).not.toMatch(/(?:^|\s)min-w-0(?:\s|$)/);
      }
    });

    it.each(['sm', 'default', 'lg'] as const)(
      'keeps the content floor at size %s, whose variant carries a min-width of its own',
      (size) => {
        render(
          <ToggleGroup type="single" aria-label="Show" size={size}>
            <ToggleGroupItem value="both">Heat and counts</ToggleGroupItem>
          </ToggleGroup>
        );

        const item = screen.getByRole('radio');
        expect(item).toHaveClass('min-w-fit');
        expect(item.className).not.toMatch(/(?:^|\s)min-w-\d/);
      }
    );

    it('gives every outline item a left edge of its own, so one that wraps onto a new line keeps it', () => {
      render(
        <ToggleGroup type="single" variant="outline" aria-label="Show">
          <ToggleGroupItem value="both">Heat and counts</ToggleGroupItem>
          <ToggleGroupItem value="heat">Heat</ToggleGroupItem>
          <ToggleGroupItem value="counts">Counts</ToggleGroupItem>
        </ToggleGroup>
      );

      for (const item of screen.getAllByRole('radio')) {
        const tokens = item.className.split(/\s+/);
        // The seam is closed by pulling each item a pixel left over its
        // neighbour's edge, rather than by dropping the edge of every item but
        // the first: `:first-child` is the first of the group, not the first of
        // a line, so a dropped edge leaves a wrapped line open on the left.
        expect(tokens).not.toContain('data-[variant=outline]:border-l-0');
        expect(tokens).toContain('data-[variant=outline]:not-first:-ml-px');
      }
    });

    it('lets a caller override the floor with its own min-width class', () => {
      render(
        <ToggleGroup type="single" aria-label="Show">
          <ToggleGroupItem value="both" className="min-w-0">
            Heat and counts
          </ToggleGroupItem>
        </ToggleGroup>
      );

      const item = screen.getByRole('radio');
      expect(item).toHaveClass('min-w-0');
      expect(item.className).not.toContain('min-w-fit');
    });
  });

  describe('pressed and hover', () => {
    function tokens(element: Element): string[] {
      return element.className.split(/\s+/);
    }

    function pressedItem(variant: 'default' | 'outline'): HTMLElement {
      render(
        <ToggleGroup type="single" variant={variant} value="bug" aria-label="Feedback type">
          <ToggleGroupItem value="bug">Bug</ToggleGroupItem>
          <ToggleGroupItem value="idea">Idea</ToggleGroupItem>
        </ToggleGroup>
      );
      const item = screen.getByRole('radio', { name: 'Bug' });
      expect(item).toHaveAttribute('data-state', 'on');
      return item;
    }

    // The test environment applies no stylesheet, so each state is read as the class
    // that carries it; how the states render is checked by eye on /dev/kit.
    it.each(['default', 'outline'] as const)(
      'sets the pressed label semibold in the %s variant',
      (variant) => {
        expect(tokens(pressedItem(variant))).toContain('data-[state=on]:font-semibold');
      }
    );

    it.each(['default', 'outline'] as const)(
      'draws a 2px inset edge in the muted foreground on the pressed item in the %s variant',
      (variant) => {
        expect(tokens(pressedItem(variant))).toEqual(
          expect.arrayContaining([
            'data-[state=on]:inset-ring-2',
            'data-[state=on]:inset-ring-muted-foreground',
          ])
        );
      }
    );

    it.each(['default', 'outline'] as const)(
      'keeps the accent fill on the pressed item in the %s variant',
      (variant) => {
        expect(tokens(pressedItem(variant))).toContain('data-[state=on]:bg-accent');
      }
    );

    it.each(['default', 'outline'] as const)(
      'fills a hovered item lighter than a pressed one in the %s variant',
      (variant) => {
        const hoverFills = tokens(pressedItem(variant)).filter((token) =>
          token.startsWith('hover:bg-')
        );

        expect(hoverFills).toEqual(['hover:bg-accent/45']);
      }
    );

    it.each(['sm', 'default', 'lg'] as const)(
      'makes each item 2.75rem tall on a coarse pointer at size %s',
      (size) => {
        render(
          <ToggleGroup type="single" size={size} aria-label="Feedback type">
            <ToggleGroupItem value="bug">Bug</ToggleGroupItem>
          </ToggleGroup>
        );

        expect(tokens(screen.getByRole('radio'))).toContain('pointer-coarse:h-11');
      }
    );

    it('draws the outline variant on the control border', () => {
      const item = pressedItem('outline');

      expect(tokens(item)).toContain('border-border-control');
      expect(tokens(item)).not.toContain('border-input');
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
