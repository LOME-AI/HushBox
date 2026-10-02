import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { PillGroup } from './pill-group';

type Window = '7d' | '30d' | 'all';
type Kind = 'all' | 'feature' | 'bug';

const WINDOWS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
] as const satisfies readonly { value: Window; label: string }[];

const KINDS = [
  { value: 'all', label: 'All', count: 14 },
  { value: 'feature', label: 'Features', count: 11 },
  { value: 'bug', label: 'Bugs', count: 3 },
] as const satisfies readonly { value: Kind; label: string; count: number }[];

function noop(): void {
  // A handler the case under test never reaches.
}

function pill(group: string, name: string | RegExp): HTMLElement {
  return within(screen.getByRole('group', { name: group })).getByRole('button', { name });
}

describe('PillGroup', () => {
  it('names its group with the label', () => {
    render(<PillGroup label="Window" options={WINDOWS} value="30d" onChange={noop} />);
    expect(screen.getByRole('group', { name: 'Window' })).toBeInTheDocument();
  });

  it('renders one button per option inside the group', () => {
    render(<PillGroup label="Window" options={WINDOWS} value="30d" onChange={noop} />);
    const group = screen.getByRole('group', { name: 'Window' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['7 days', '30 days', 'All time']);
  });

  it('presses exactly the pill whose value is chosen', () => {
    render(<PillGroup label="Window" options={WINDOWS} value="30d" onChange={noop} />);
    const pressed = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed.map((b) => b.textContent)).toEqual(['30 days']);
  });

  it('marks every other pill as not pressed', () => {
    render(<PillGroup label="Window" options={WINDOWS} value="30d" onChange={noop} />);
    expect(pill('Window', '7 days')).toHaveAttribute('aria-pressed', 'false');
    expect(pill('Window', 'All time')).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onChange with the clicked pill value', async () => {
    const onChange = vi.fn<(value: Window) => void>();
    render(<PillGroup label="Window" options={WINDOWS} value="30d" onChange={onChange} />);
    await userEvent.click(pill('Window', 'All time'));
    expect(onChange).toHaveBeenCalledWith('all');
  });

  it('renders each pill as a bare, non-submitting button', () => {
    render(<PillGroup label="Window" options={WINDOWS} value="30d" onChange={noop} />);
    const button = pill('Window', '7 days');
    expect(button).toHaveAttribute('data-variant', 'bare');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('renders the count after the label', () => {
    render(<PillGroup label="Type" options={KINDS} value="all" onChange={noop} />);
    const button = pill('Type', 'Features 11');
    expect(button.textContent).toBe('Features11');
    expect(within(button).getByText('11').previousElementSibling).toHaveTextContent('Features');
  });

  it('renders no count when an option has none', () => {
    render(<PillGroup label="Window" options={WINDOWS} value="30d" onChange={noop} />);
    expect(pill('Window', '7 days').children).toHaveLength(1);
  });

  it('moves focus through the pills in option order with Tab', async () => {
    render(<PillGroup label="Type" options={KINDS} value="feature" onChange={noop} />);
    await userEvent.tab();
    expect(pill('Type', /^All/)).toHaveFocus();
    await userEvent.tab();
    expect(pill('Type', /^Features/)).toHaveFocus();
    await userEvent.tab();
    expect(pill('Type', /^Bugs/)).toHaveFocus();
  });

  it('draws the pressed pill white on Signal Red', () => {
    render(<PillGroup label="Window" options={WINDOWS} value="30d" onChange={noop} />);
    expect(pill('Window', '30 days')).toHaveClass(
      'bg-primary',
      'border-primary',
      'text-primary-foreground'
    );
  });

  it('draws an unpressed pill with the control border, muted ink and the hover fill', () => {
    render(<PillGroup label="Window" options={WINDOWS} value="30d" onChange={noop} />);
    expect(pill('Window', '7 days')).toHaveClass(
      'border-border-control',
      'text-muted-foreground',
      'hover:bg-background-subtle'
    );
  });

  it('keeps the unpressed look off the pressed pill', () => {
    render(<PillGroup label="Window" options={WINDOWS} value="30d" onChange={noop} />);
    expect(pill('Window', '30 days')).not.toHaveClass(
      'border-border-control',
      'text-muted-foreground'
    );
  });

  it('draws the medium pills by default', () => {
    render(<PillGroup label="Window" options={WINDOWS} value="30d" onChange={noop} />);
    expect(pill('Window', '7 days')).toHaveClass('px-3.5', 'py-1.5');
  });

  it('draws the compact pills at size sm', () => {
    render(<PillGroup label="Type" options={KINDS} value="all" onChange={noop} size="sm" />);
    expect(pill('Type', /^Bugs/)).toHaveClass('h-8', 'px-3');
  });

  it('gives every pill the touch height on a coarse pointer', () => {
    render(<PillGroup label="Type" options={KINDS} value="all" onChange={noop} size="sm" />);
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveClass('pointer-coarse:min-h-11');
    }
  });

  it('wraps the pills as a group', () => {
    render(<PillGroup label="Window" options={WINDOWS} value="30d" onChange={noop} />);
    expect(screen.getByRole('group', { name: 'Window' })).toHaveClass('flex', 'flex-wrap');
  });

  it('writes no raw button element in its source', () => {
    const source = readFileSync(path.resolve(__dirname, './pill-group.tsx'), 'utf8');
    expect(source).not.toMatch(/<button[\s/>]/);
  });
});
