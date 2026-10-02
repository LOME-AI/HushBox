import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Input } from '../primitives/input';
import { InlineInput } from './inline-input';
import { SIMPLE_INPUT_CLASSES } from './simple-input-classes';

function tokens(element: Element): string[] {
  return element.className.split(/\s+/);
}

function byName(a: string, b: string): number {
  return a.localeCompare(b);
}

/** The simple `Input`'s rendered classes as they stood before it shared the recipe. */
const SIMPLE_INPUT_RENDERED = [
  'file:text-foreground',
  'placeholder:text-muted-foreground',
  'selection:bg-primary',
  'selection:text-primary-foreground',
  'dark:bg-input/30',
  'border-input',
  'h-9',
  'w-full',
  'min-w-0',
  'appearance-none',
  'rounded-md',
  'border',
  'bg-transparent',
  'px-3',
  'py-1',
  'text-base',
  'shadow-xs',
  'transition-[color,box-shadow]',
  'file:inline-flex',
  'file:h-7',
  'file:border-0',
  'file:bg-transparent',
  'file:text-sm',
  'file:font-medium',
  'disabled:pointer-events-none',
  'disabled:cursor-not-allowed',
  'disabled:opacity-50',
  'md:text-sm',
  'focus-visible:border-ring',
  'focus-visible:outline-hidden',
  'aria-invalid:border-destructive',
];

describe('the simple-input recipe', () => {
  it('names no border colour, so each input picks its own', () => {
    const colours = SIMPLE_INPUT_CLASSES.split(' ').filter((token) =>
      /^border-(input|border-control)$/.test(token)
    );

    expect(colours).toEqual([]);
  });

  it('is drawn whole by the inline input', () => {
    render(<InlineInput aria-label="Search members" />);

    expect(tokens(screen.getByRole('textbox'))).toEqual(
      expect.arrayContaining(SIMPLE_INPUT_CLASSES.split(' '))
    );
  });

  it('is drawn whole by the simple Input', () => {
    render(<Input aria-label="Search" />);

    expect(tokens(screen.getByRole('textbox'))).toEqual(
      expect.arrayContaining(SIMPLE_INPUT_CLASSES.split(' '))
    );
  });

  it('leaves the simple Input rendering exactly the classes it did before', () => {
    render(<Input aria-label="Search" />);

    expect(tokens(screen.getByRole('textbox')).toSorted(byName)).toEqual(
      SIMPLE_INPUT_RENDERED.toSorted(byName)
    );
  });
});
