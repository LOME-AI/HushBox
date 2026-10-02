import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, onTestFinished, vi } from 'vitest';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
} from './select';
import { PortalContainerProvider } from './portal-container';

const FRUITS = [
  { value: 'apple', label: 'Apple' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
  { value: 'date', label: 'Date' },
] as const;

function FruitSelect({ chosen }: Readonly<{ chosen: string[] }>): React.JSX.Element {
  const [value, setValue] = React.useState('apple');
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        chosen.push(next);
        setValue(next);
      }}
    >
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FRUITS.map((fruit) => (
          <SelectItem key={fruit.value} value={fruit.value}>
            {fruit.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

async function openFruitSelectByKeyboard(chosen: string[]): Promise<void> {
  const user = userEvent.setup();
  render(<FruitSelect chosen={chosen} />);
  await user.tab();
  await user.keyboard('{Enter}');
  await waitFor(() => {
    expect(screen.getByRole('option', { name: 'Apple' })).toHaveFocus();
  });
}

/**
 * Presses a key on the focused element, then yields one microtask checkpoint and no timer turn,
 * as a browser does between two key events queued behind a long task.
 */
async function pressBeforeATimerTurn(key: string): Promise<void> {
  const target = document.activeElement;
  if (target === null) throw new Error('No element holds focus');
  fireEvent.keyDown(target, { key });
  await Promise.resolve();
}

describe('Select', () => {
  it('renders trigger element', () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select an option" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option 1</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByText('Select an option')).toBeInTheDocument();
  });

  it('opens select when trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option 1</SelectItem>
          <SelectItem value="2">Option 2</SelectItem>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByText('Option 1')).toBeInTheDocument();
      expect(screen.getByText('Option 2')).toBeInTheDocument();
    });
  });

  it('selects item when clicked', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Select onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="option1">Option 1</SelectItem>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByText('Option 1')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Option 1'));
    expect(onValueChange).toHaveBeenCalledWith('option1');
  });

  it('trigger has data-slot attribute', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByTestId('trigger')).toHaveAttribute('data-slot', 'select-trigger');
  });

  it('renders controlled select', () => {
    render(
      <Select value="option1">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="option1">Selected Option</SelectItem>
        </SelectContent>
      </Select>
    );

    expect(screen.getByText('Selected Option')).toBeInTheDocument();
  });

  it('supports disabled state', () => {
    render(
      <Select disabled>
        <SelectTrigger data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );

    expect(screen.getByTestId('trigger')).toBeDisabled();
  });

  it('moves focus between options with the arrow keys', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">First</SelectItem>
          <SelectItem value="2">Second</SelectItem>
        </SelectContent>
      </Select>
    );

    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    expect(screen.getByRole('option', { name: 'First' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');

    const second = screen.getByRole('option', { name: 'Second' });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute('data-slot', 'select-item');
  });

  it('returns focus to the trigger when an option is chosen by keyboard', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">First</SelectItem>
          <SelectItem value="2">Second</SelectItem>
        </SelectContent>
      </Select>
    );

    const trigger = screen.getByRole('combobox');
    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
    expect(trigger).toHaveTextContent('Second');
  });

  it('chooses the option the arrow keys reached when each key arrives before a timer turn', async () => {
    const chosen: string[] = [];
    await openFruitSelectByKeyboard(chosen);

    await act(async () => {
      await pressBeforeATimerTurn('ArrowDown');
      await pressBeforeATimerTurn('ArrowDown');
      await pressBeforeATimerTurn('Enter');
    });

    expect(chosen).toEqual(['cherry']);
  });

  it('chooses the option typeahead reached when Enter arrives before a timer turn', async () => {
    const chosen: string[] = [];
    await openFruitSelectByKeyboard(chosen);

    await act(async () => {
      await pressBeforeATimerTurn('c');
      await pressBeforeATimerTurn('Enter');
    });

    expect(chosen).toEqual(['cherry']);
  });

  it('raises no uncaught error when the select closes right after a typeahead letter', async () => {
    const uncaught: unknown[] = [];
    const recordUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', recordUncaught);
    try {
      await openFruitSelectByKeyboard([]);

      await act(async () => {
        await pressBeforeATimerTurn('c');
        await pressBeforeATimerTurn('Escape');
      });
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', recordUncaught);
    }
  });
});

describe('SelectTrigger', () => {
  it('applies custom className', () => {
    render(
      <Select>
        <SelectTrigger className="custom-class" data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByTestId('trigger')).toHaveClass('custom-class');
  });

  it('supports sm size', () => {
    render(
      <Select>
        <SelectTrigger size="sm" data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByTestId('trigger')).toHaveAttribute('data-size', 'sm');
  });

  it('supports default size', () => {
    render(
      <Select>
        <SelectTrigger size="default" data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByTestId('trigger')).toHaveAttribute('data-size', 'default');
  });
});

describe('SelectItem', () => {
  it('has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1" data-testid="item">
            Option
          </SelectItem>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByTestId('item')).toHaveAttribute('data-slot', 'select-item');
    });
  });

  it('applies custom className', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1" className="custom-class" data-testid="item">
            Option
          </SelectItem>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByTestId('item')).toHaveClass('custom-class');
    });
  });

  it('supports disabled state', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1" disabled data-testid="item">
            Disabled Option
          </SelectItem>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByTestId('item')).toHaveAttribute('data-disabled');
    });
  });
});

describe('SelectGroup', () => {
  it('has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup data-testid="group">
            <SelectLabel>Group Label</SelectLabel>
            <SelectItem value="1">Option</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByTestId('group')).toHaveAttribute('data-slot', 'select-group');
    });
  });
});

describe('SelectLabel', () => {
  it('renders label text', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>My Label</SelectLabel>
            <SelectItem value="1">Option</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByText('My Label')).toBeInTheDocument();
    });
  });

  it('has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel data-testid="label">Label</SelectLabel>
            <SelectItem value="1">Option</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByTestId('label')).toHaveAttribute('data-slot', 'select-label');
    });
  });
});

describe('SelectSeparator', () => {
  it('has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option 1</SelectItem>
          <SelectSeparator data-testid="separator" />
          <SelectItem value="2">Option 2</SelectItem>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByTestId('separator')).toHaveAttribute('data-slot', 'select-separator');
    });
  });
});

describe('SelectValue', () => {
  it('has data-slot attribute', () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue data-testid="value" placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByTestId('value')).toHaveAttribute('data-slot', 'select-value');
  });

  it('displays placeholder when no value', () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Choose option" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByText('Choose option')).toBeInTheDocument();
  });

  it('applies popper-positioning classes when position is popper', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="1">Option 1</SelectItem>
        </SelectContent>
      </Select>
    );
    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      const content = document.querySelector('[data-slot="select-content"]');
      expect(content).not.toBeNull();
      expect(content!.className).toContain('data-[side=bottom]:translate-y-1');
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

/** The element directly under the document body that holds `element`. */
function bodyChildHolding(element: HTMLElement): Element | undefined {
  return [...document.body.children].find((child) => child.contains(element));
}

describe('SelectContent portal', () => {
  it('portals the list to the document body when given no container', () => {
    const { container } = render(
      <Select open value="apple">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="apple">Apple</SelectItem>
        </SelectContent>
      </Select>
    );

    const holder = bodyChildHolding(screen.getByRole('listbox'));
    expect(holder).toBeDefined();
    expect(holder).not.toBe(container);
  });

  it('portals the list into the container it is given', () => {
    const target = portalTarget();
    render(
      <Select open value="apple">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent container={target}>
          <SelectItem value="apple">Apple</SelectItem>
        </SelectContent>
      </Select>
    );

    expect(target).toContainElement(screen.getByRole('listbox'));
  });

  it('portals the list into the element its provider gives', () => {
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <Select open value="apple">
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="apple">Apple</SelectItem>
          </SelectContent>
        </Select>
      </PortalContainerProvider>
    );

    expect(target).toContainElement(screen.getByRole('listbox'));
  });

  it('portals the list into its own container over the provider', () => {
    const provided = portalTarget();
    const own = portalTarget();
    render(
      <PortalContainerProvider container={provided}>
        <Select open value="apple">
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent container={own}>
            <SelectItem value="apple">Apple</SelectItem>
          </SelectContent>
        </Select>
      </PortalContainerProvider>
    );

    expect(own).toContainElement(screen.getByRole('listbox'));
    expect(provided).not.toContainElement(screen.getByRole('listbox'));
  });
});
