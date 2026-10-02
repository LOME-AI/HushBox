import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { Image, Lock } from 'lucide-react';
import { Menu } from './menu';
import { MenuItem } from './menu-item';
import { MenuRadioGroup } from './menu-radio-group';
import { MenuRadioItem } from './menu-radio-item';
import { DESKTOP, PHONE, installViewport, restoreViewport } from './menu-viewport.setup';
import type { MenuItemLook } from './menu-item-body';

afterEach(() => {
  restoreViewport();
});

function ImageRow(look: Readonly<Partial<MenuItemLook>>): React.JSX.Element {
  return (
    <Menu trigger={<button type="button">Mode</button>} title="Change mode" open>
      <MenuRadioGroup<'text' | 'image'> value="text" onValueChange={() => undefined}>
        <MenuRadioItem<'text' | 'image'> value="image" icon={Image} title="Image" {...look} />
      </MenuRadioGroup>
    </Menu>
  );
}

const LOCK = <Lock data-testid="lock" />;

describe.each([
  ['anchored', DESKTOP],
  ['sheet', PHONE],
])('a row in the %s menu', (_presentation, width) => {
  it("sets a mark in the check's own cell, the last in the row", () => {
    installViewport(width);
    render(<ImageRow disabled disabledReason="Add credit" mark={LOCK} />);

    const row = screen.getByRole('menuitemradio', { name: 'Image' });

    expect(row.lastElementChild).toContainElement(screen.getByTestId('lock'));
  });

  it("gives a mark the check's 1rem square", () => {
    installViewport(width);
    render(<ImageRow disabled disabledReason="Add credit" mark={LOCK} />);

    expect(screen.getByTestId('lock').parentElement).toHaveClass('size-4', 'shrink-0');
  });

  it('draws no check beside a mark', () => {
    installViewport(width);
    render(<ImageRow disabled disabledReason="Add credit" mark={LOCK} />);

    const row = screen.getByRole('menuitemradio', { name: 'Image' });
    screen.getByTestId('lock');
    const others = [...row.querySelectorAll('svg')].filter(
      (svg) => svg.dataset['testid'] !== 'lock'
    );

    // The mode icon alone remains once the lock is set aside.
    expect(others).toHaveLength(1);
  });

  it('keeps the end slot ahead of the check when there is no mark', () => {
    installViewport(width);
    render(<ImageRow end="Ctrl I" />);

    const row = screen.getByRole('menuitemradio', { name: 'Image' });

    expect(row.lastElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(row.lastElementChild?.previousElementSibling).toHaveTextContent('Ctrl I');
  });
});

function CheckedRows(): React.JSX.Element {
  return (
    <Menu trigger={<button type="button">Mode</button>} title="Change mode" open>
      <MenuRadioGroup<'text' | 'image'> value="image" onValueChange={() => undefined}>
        <MenuRadioItem<'text' | 'image'> value="image" icon={Image} title="Image" />
      </MenuRadioGroup>
      <MenuItem title="Web search" checked onSelect={() => undefined} />
    </Menu>
  );
}

describe.each([
  ['anchored', DESKTOP],
  ['sheet', PHONE],
])('a checked row in the %s menu', (_presentation, width) => {
  it.each([
    ['menuitemradio', 'Image', 'last'],
    ['menuitemcheckbox', 'Web search', 'first'],
  ] as const)('draws the %s check in muted ink', (role, name, place) => {
    installViewport(width);
    render(<CheckedRows />);

    const row = screen.getByRole(role, { name });
    const check = place === 'last' ? row.lastElementChild : row.firstElementChild;

    expect(check).toHaveClass('text-muted-foreground');
  });

  it.each([
    ['menuitemradio', 'Image', 'last'],
    ['menuitemcheckbox', 'Web search', 'first'],
  ] as const)('keeps brand red off the %s check', (role, name, place) => {
    installViewport(width);
    render(<CheckedRows />);

    const row = screen.getByRole(role, { name });
    const check = place === 'last' ? row.lastElementChild : row.firstElementChild;

    expect(check).not.toHaveClass('text-primary');
  });
});

/** One two-line rung, as the effort menu draws it, at the density it is given. */
function Rung(look: Readonly<Partial<MenuItemLook>>): React.JSX.Element {
  return (
    <Menu trigger={<button type="button">Effort</button>} title="Reasoning effort" open>
      <MenuRadioGroup<'high' | 'mid'> value="mid" onValueChange={() => undefined}>
        <MenuRadioItem<'high' | 'mid'>
          value="high"
          title="High"
          description="Careful multi-step work"
          {...look}
        />
      </MenuRadioGroup>
    </Menu>
  );
}

function rungParts(): { row: HTMLElement; title: HTMLElement; text: HTMLElement } {
  const row = screen.getByRole('menuitemradio', { name: 'High' });
  const title = screen.getByText('High');
  const text = title.parentElement;
  if (text === null) throw new Error('the title sits in the text column');
  return { row, title, text };
}

describe.each([
  ['anchored', DESKTOP],
  ['sheet', PHONE],
])('a compact row in the %s menu', (_presentation, width) => {
  it('pads its two lines by 0.3125rem', () => {
    installViewport(width);
    render(<Rung density="compact" />);

    const { row } = rungParts();

    expect(row).toHaveClass('py-1.25');
    expect(row).not.toHaveClass('py-1.75');
  });

  it('sets its title at a 1.25 line height', () => {
    installViewport(width);
    render(<Rung density="compact" />);

    expect(rungParts().title).toHaveClass('leading-tight');
  });

  it('leaves 1px between its title and its line', () => {
    installViewport(width);
    render(<Rung density="compact" />);

    const { text } = rungParts();

    expect(text).toHaveClass('gap-px');
    expect(text).not.toHaveClass('gap-0.5');
  });
});

describe.each([
  ['anchored', DESKTOP],
  ['sheet', PHONE],
])('a row given no density in the %s menu', (_presentation, width) => {
  it('keeps its two-line padding', () => {
    installViewport(width);
    render(<Rung />);

    expect(rungParts().row).toHaveClass('py-1.75');
  });

  it("keeps its title's line height", () => {
    installViewport(width);
    render(<Rung />);

    expect(rungParts().title).not.toHaveClass('leading-tight');
  });

  it('keeps its 2px gap', () => {
    installViewport(width);
    render(<Rung />);

    expect(rungParts().text).toHaveClass('gap-0.5');
  });
});
