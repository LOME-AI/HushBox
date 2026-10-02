import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Button, buttonVariants, type ButtonSize, type ButtonVariant } from './button';

const FILLED: readonly ButtonVariant[] = ['default', 'secondary', 'destructive'];
const CLEAR: readonly ButtonVariant[] = ['ghost', 'link'];
const DRAWN: readonly ButtonVariant[] = [...FILLED, 'outline', ...CLEAR];

function button(): HTMLElement {
  return screen.getByRole('button');
}

/** The properties a `transition-[…]` utility names, or the shorthand utility itself. */
function transitionedProperties(element: HTMLElement): string[] {
  return [...element.classList]
    .filter((token) => token.startsWith('transition'))
    .flatMap((token) => {
      const list = /^transition-\[(.+)\]$/.exec(token)?.[1];
      return list === undefined ? [token] : list.split(',');
    });
}

describe('Button variants', () => {
  it.each([
    ['default', ['bg-primary', 'text-primary-foreground', 'hover:bg-primary/90']],
    ['secondary', ['bg-secondary', 'text-secondary-foreground', 'hover:bg-secondary/80']],
    [
      'outline',
      [
        'border-border-control',
        'bg-background',
        'shadow-xs',
        'hover:bg-accent',
        'dark:bg-input/30',
      ],
    ],
    ['ghost', ['hover:bg-accent', 'hover:text-accent-foreground']],
    ['link', ['text-primary', 'underline-offset-4', 'hover:underline', 'h-auto', 'px-0']],
    ['destructive', ['bg-destructive', 'text-white', 'dark:bg-destructive/60']],
  ] as const)('the %s variant renders its class set', (variant, tokens) => {
    render(<Button variant={variant}>Label</Button>);

    expect(button()).toHaveAttribute('data-variant', variant);
    expect(button()).toHaveClass(...tokens);
  });

  it('renders the default variant when none is named', () => {
    render(<Button>Save</Button>);

    expect(button()).toHaveAttribute('data-variant', 'default');
  });

  it('draws a transparent border on every drawn variant so a disabled border has a place', () => {
    render(<Button variant="default">Save</Button>);

    expect(button()).toHaveClass('border', 'border-transparent');
  });
});

describe('Button sizes', () => {
  it.each([
    ['sm', ['h-8', 'px-3']],
    ['default', ['h-9', 'px-4']],
    ['lg', ['h-10', 'px-6']],
    ['xl', ['h-14', 'font-black', 'rounded-sm']],
  ] as const)('the %s size renders its class set', (size: ButtonSize, tokens) => {
    render(<Button size={size}>Label</Button>);

    expect(button()).toHaveAttribute('data-size', size);
    expect(button()).toHaveClass(...tokens);
  });

  it('renders the default size when none is named', () => {
    render(<Button>Save</Button>);

    expect(button()).toHaveAttribute('data-size', 'default');
  });

  it('xl keeps no clip path', () => {
    render(<Button size="xl">Log in</Button>);

    expect(button().getAttribute('style') ?? '').not.toContain('clip-path');
  });

  it.each(DRAWN)('a %s button is at least 2.75rem tall on a coarse pointer', (variant) => {
    render(<Button variant={variant}>Label</Button>);

    expect(button()).toHaveClass('pointer-coarse:min-h-11');
  });
});

describe('Button disabled', () => {
  it.each(FILLED)('a disabled %s button takes the neutral fill, border and ink', (variant) => {
    render(
      <Button variant={variant} disabled>
        Label
      </Button>
    );

    expect(button()).toHaveClass(
      'disabled:bg-muted',
      'disabled:border-border',
      'disabled:text-disabled-ink'
    );
  });

  it.each(FILLED)('an aria-disabled %s button renders the same neutral look', (variant) => {
    render(
      <Button variant={variant} aria-disabled="true">
        Label
      </Button>
    );

    expect(button()).toHaveClass(
      'aria-disabled:bg-muted',
      'aria-disabled:border-border',
      'aria-disabled:text-disabled-ink'
    );
  });

  it('a disabled destructive button stays neutral in dark', () => {
    render(
      <Button variant="destructive" disabled>
        Delete
      </Button>
    );

    expect(button()).toHaveClass('dark:disabled:bg-muted', 'dark:aria-disabled:bg-muted');
  });

  it('a disabled outline button keeps a disabled border on a transparent fill', () => {
    render(
      <Button variant="outline" disabled>
        Export
      </Button>
    );

    expect(button()).toHaveClass(
      'disabled:border-border',
      'disabled:bg-transparent',
      'dark:disabled:bg-transparent',
      'disabled:shadow-none',
      'disabled:text-disabled-ink',
      'aria-disabled:border-border',
      'aria-disabled:bg-transparent',
      'dark:aria-disabled:bg-transparent',
      'aria-disabled:shadow-none',
      'aria-disabled:text-disabled-ink'
    );
  });

  it.each(CLEAR)('a disabled %s button has a transparent fill and no underline', (variant) => {
    render(
      <Button variant={variant} disabled>
        Skip
      </Button>
    );

    expect(button()).toHaveClass(
      'disabled:bg-transparent',
      'disabled:no-underline',
      'disabled:text-disabled-ink',
      'aria-disabled:bg-transparent',
      'aria-disabled:no-underline',
      'aria-disabled:text-disabled-ink'
    );
  });

  it('shows a not-allowed cursor when disabled either way', () => {
    render(<Button>Save</Button>);

    expect(button()).toHaveClass('disabled:cursor-not-allowed', 'aria-disabled:cursor-not-allowed');
  });

  it('keeps pointer events while disabled so the cursor shows', () => {
    render(<Button disabled>Save</Button>);

    expect(button()).not.toHaveClass('disabled:pointer-events-none');
  });

  it('does not fade a disabled button', () => {
    render(<Button disabled>Save</Button>);

    expect(button()).not.toHaveClass('disabled:opacity-50');
  });

  it('a disabled button does not call onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Save
      </Button>
    );

    await user.click(button());

    expect(onClick).not.toHaveBeenCalled();
  });

  it('an aria-disabled button does not call onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} aria-disabled="true">
        Save
      </Button>
    );

    await user.click(button());

    expect(onClick).not.toHaveBeenCalled();
  });

  it('an aria-disabled submit button does not submit its form', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.SyntheticEvent) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" aria-disabled="true">
          Save
        </Button>
      </form>
    );

    await user.click(button());

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('an aria-disabled button stays focusable', () => {
    render(<Button aria-disabled="true">Save</Button>);
    button().focus();

    expect(button()).toHaveFocus();
  });
});

describe('Button loading', () => {
  it('announces busy', () => {
    render(<Button loading>Save</Button>);

    expect(button()).toHaveAttribute('aria-busy', 'true');
  });

  it('is not busy while idle', () => {
    render(<Button loading={false}>Save</Button>);

    expect(button()).not.toHaveAttribute('aria-busy');
  });

  it('shows one spinner', () => {
    const { container } = render(<Button loading>Save</Button>);

    expect(container.querySelectorAll('[data-slot="spinner"]')).toHaveLength(1);
  });

  it('names itself by the loading label while loading', () => {
    render(
      <Button loading loadingLabel="Saving">
        Save
      </Button>
    );

    expect(button()).toHaveAccessibleName('Saving');
  });

  it('keeps its idle label while loading when no loading label is given', () => {
    render(<Button loading>Save</Button>);

    expect(button()).toHaveAccessibleName('Save');
  });

  it('names itself by its idle label while idle', () => {
    render(
      <Button loading={false} loadingLabel="Saving">
        Save
      </Button>
    );

    expect(button()).toHaveAccessibleName('Save');
  });

  it.each([true, false])(
    'lays the idle and loading labels in one grid cell so the width holds (loading %s)',
    (loading) => {
      const { container } = render(
        <Button loading={loading} loadingLabel="Saving">
          Save
        </Button>
      );
      const cells = [...container.querySelectorAll('[data-slot="button-label"] > span')];

      expect(cells).toHaveLength(2);
      for (const cell of cells) expect(cell).toHaveClass('col-start-1', 'row-start-1');
    }
  );

  it('hides the reserved label from sight and from assistive technology', () => {
    const { container } = render(
      <Button loading loadingLabel="Saving">
        Save
      </Button>
    );
    const reserved = container.querySelector('[data-slot="button-reservation"]');

    expect(reserved).toHaveClass('invisible');
    expect(reserved).toHaveAttribute('aria-hidden', 'true');
    expect(reserved).toHaveTextContent('Save');
  });

  it('refuses clicks while loading', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>
    );

    await user.click(button());

    expect(onClick).not.toHaveBeenCalled();
  });

  it('calls onClick when idle', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading={false} onClick={onClick}>
        Save
      </Button>
    );

    await user.click(button());

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('keeps its colours while loading rather than going neutral', () => {
    render(<Button loading>Save</Button>);

    expect(button()).not.toBeDisabled();
    expect(button()).not.toHaveAttribute('aria-disabled');
  });

  it('shows a progress cursor while busy', () => {
    render(<Button loading>Save</Button>);

    expect(button()).toHaveClass('aria-busy:cursor-progress');
  });

  it('renders children directly when loading is not in play', () => {
    const { container } = render(<Button>Save</Button>);

    expect(container.querySelector('[data-slot="button-label"]')).toBeNull();
  });
});

describe('Button bare', () => {
  it('carries no visual recipe', () => {
    render(<Button variant="bare">Row</Button>);
    const tokens = [...button().classList];

    expect(
      tokens.filter((token) => /^(bg-|h-|px-|text-|border|rounded|shadow|inline-flex)/.test(token))
    ).toEqual([]);
  });

  it('is a plain button by default so it never submits a form', () => {
    render(<Button variant="bare">Row</Button>);

    expect(button()).toHaveAttribute('type', 'button');
  });

  it('takes the type a caller gives', () => {
    render(
      <Button variant="bare" type="submit">
        Row
      </Button>
    );

    expect(button()).toHaveAttribute('type', 'submit');
  });

  it('shows a not-allowed cursor when disabled', () => {
    render(<Button variant="bare">Row</Button>);

    expect(button()).toHaveClass('disabled:cursor-not-allowed', 'aria-disabled:cursor-not-allowed');
  });

  it('leaves its height to the caller on a coarse pointer', () => {
    render(<Button variant="bare">Row</Button>);

    expect(button()).not.toHaveClass('pointer-coarse:min-h-11');
  });

  it('an aria-disabled bare button does not call onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button variant="bare" aria-disabled="true" onClick={onClick}>
        Row
      </Button>
    );

    await user.click(button());

    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Button focus', () => {
  it('transitions no outline property, so the focus outline appears at once', () => {
    render(<Button>Save</Button>);
    const properties = transitionedProperties(button());

    expect(properties.length).toBeGreaterThan(0);
    expect(
      properties.filter((property) =>
        /outline|^all$|^transition$|^transition-(all|colors)$/.test(property)
      )
    ).toEqual([]);
  });

  it('leaves the base focus outline to draw', () => {
    render(<Button>Save</Button>);

    expect([...button().classList].filter((token) => token.includes('outline'))).toEqual([]);
  });
});

describe('Button semantics', () => {
  it('has no type by default, as a native button', () => {
    render(<Button>Save</Button>);

    expect(button()).not.toHaveAttribute('type');
  });

  it('marks its slot for the focus and layout rules', () => {
    render(<Button>Save</Button>);

    expect(button()).toHaveAttribute('data-slot', 'button');
  });

  it('marks a block button for the width rule', () => {
    render(<Button block>Log in</Button>);

    expect(button()).toHaveAttribute('data-block', '');
  });

  it('carries no block mark otherwise', () => {
    render(<Button>Log in</Button>);

    expect(button()).not.toHaveAttribute('data-block');
  });

  it('applies a caller class last', () => {
    render(<Button className="w-full">Save</Button>);

    expect(button()).toHaveClass('w-full');
  });

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    await user.click(button());

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('forwards its ref to the button element', () => {
    const ref = vi.fn();
    render(<Button ref={ref}>Save</Button>);

    expect(ref).toHaveBeenCalledWith(expect.any(HTMLButtonElement));
  });

  it('renders as its child when asChild is set', () => {
    render(
      <Button asChild>
        <a href="/somewhere">Open</a>
      </Button>
    );
    const link = screen.getByRole('link', { name: 'Open' });

    expect(link).toHaveAttribute('data-slot', 'button');
    expect(link).toHaveClass('bg-primary');
  });

  it('refuses clicks on an aria-disabled child when asChild is set', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button asChild aria-disabled="true" onClick={onClick}>
        <a href="#open">Open</a>
      </Button>
    );

    await user.click(screen.getByRole('link', { name: 'Open' }));

    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('buttonVariants', () => {
  it('returns the class string a variant and size draw', () => {
    const classes = buttonVariants({ variant: 'outline', size: 'sm' }).split(' ');

    expect(classes).toEqual(expect.arrayContaining(['border-border-control', 'h-8']));
  });

  it('draws the default variant and size when none is named', () => {
    const classes = buttonVariants({}).split(' ');

    expect(classes).toEqual(expect.arrayContaining(['bg-primary', 'h-9']));
  });
});
