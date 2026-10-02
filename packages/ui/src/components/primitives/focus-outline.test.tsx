import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { ThemeToggle } from '../composites/theme-toggle';

import { Badge } from './badge';
import { Button } from './button';
import { Checkbox } from './checkbox';
import { Input } from './input';
import { RadioGroup, RadioGroupItem } from './radio-group';
import { ScrollArea } from './scroll-area';
import { Select, SelectTrigger, SelectValue } from './select';
import { Switch } from './switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import { Textarea } from './textarea';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

// The shared stylesheet's base layer outlines every keyboard-focused element; a control
// draws that outline by leaving its own outline alone. Forced colors keep an outline
// and drop a box-shadow ring, so a control either leaves the outline alone or hides it
// with `focus-visible:outline-hidden`, which Tailwind turns into a transparent outline
// that forced colors paint. These tests read class tokens because the test DOM computes
// no Tailwind CSS.

const BUTTON_VARIANTS = [
  'default',
  'destructive',
  'outline',
  'secondary',
  'ghost',
  'link',
] as const;

/** The controls that draw the base outline on keyboard focus, by `data-slot`. */
const OUTLINED_SLOTS = [
  'button',
  'badge',
  'checkbox',
  'radio-group-item',
  'select-trigger',
  'switch',
  'toggle-group-item',
] as const;

/** The primitives that once drew a translucent focus ring, by `data-slot`. */
const RING_FREE_SLOTS = [...OUTLINED_SLOTS, 'input', 'textarea'] as const;

const FOCUSABLE_SLOTS = [
  ...RING_FREE_SLOTS,
  'scroll-area-viewport',
  'tabs-trigger',
  'tabs-content',
] as const;

interface Control {
  slot: string;
  tokens: string[];
}

function renderEveryFocusableControl(): Control[] {
  const { container } = render(
    <div>
      {BUTTON_VARIANTS.map((variant) => (
        <Button key={variant} variant={variant}>
          {variant}
        </Button>
      ))}
      <Badge asChild>
        <a href="#badge">badge</a>
      </Badge>
      <Checkbox aria-label="checkbox" />
      <Input aria-label="input" />
      <RadioGroup aria-label="radio group">
        <RadioGroupItem value="one" aria-label="radio" />
      </RadioGroup>
      <ScrollArea>
        <p>scrollable</p>
      </ScrollArea>
      <Select>
        <SelectTrigger aria-label="select">
          <SelectValue placeholder="select" />
        </SelectTrigger>
      </Select>
      <Switch aria-label="switch" />
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">one</TabsTrigger>
        </TabsList>
        <TabsContent value="one">panel</TabsContent>
      </Tabs>
      <Textarea aria-label="textarea" />
      <ToggleGroup type="single">
        <ToggleGroupItem value="one">one</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
  return [...container.querySelectorAll<HTMLElement>('[data-slot]')]
    .map((element) => ({ slot: element.dataset['slot'] ?? '', tokens: [...element.classList] }))
    .filter(({ slot }) => (FOCUSABLE_SLOTS as readonly string[]).includes(slot));
}

function controlsIn(slots: readonly string[]): Control[] {
  return renderEveryFocusableControl().filter(({ slot }) => slots.includes(slot));
}

/** The utility a token applies, with its variant prefixes dropped. */
function utility(token: string): string {
  return token.slice(token.lastIndexOf(':') + 1);
}

const OUTLINE_SUPPRESSION = /(^|:)outline-(none|hidden)$/;
const FOCUS_OUTLINE_WIDTH = /^focus-visible:outline-(\[[^\]]+\]|\d+)$/;

function suppressions(tokens: readonly string[]): string[] {
  return tokens.filter((token) => OUTLINE_SUPPRESSION.test(token));
}

describe('focus indicator', () => {
  it('finds the controls it checks', () => {
    const slots = renderEveryFocusableControl().map(({ slot }) => slot);

    expect(new Set(slots)).toEqual(new Set(FOCUSABLE_SLOTS));
  });

  it('no primitive draws the translucent focus ring', () => {
    const offenders = controlsIn(RING_FREE_SLOTS)
      .filter(({ tokens }) =>
        tokens.some((token) => token.includes('ring-[3px]') || token.includes('ring-ring/50'))
      )
      .map(({ slot }) => slot);

    expect(offenders).toEqual([]);
  });

  it('an outlined control leaves the base outline to draw', () => {
    const offenders = controlsIn(OUTLINED_SLOTS)
      .filter(({ tokens }) => tokens.some((token) => utility(token).startsWith('outline')))
      .map(({ slot }) => slot);

    expect(offenders).toEqual([]);
  });

  it('the labelled input leaves the base outline to draw', () => {
    const { getByLabelText } = render(<Input label="Email" />);
    const tokens = [...getByLabelText('Email').classList];

    expect(tokens.filter((token) => utility(token).startsWith('outline'))).toEqual([]);
  });

  it('the theme toggle leaves the base outline to draw', () => {
    const { getByRole } = render(<ThemeToggle />);
    const tokens = [...getByRole('button').classList];

    expect(tokens.filter((token) => utility(token).startsWith('outline'))).toEqual([]);
  });

  it('the plain input and the textarea show focus as a border colour', () => {
    const missing = controlsIn(['input', 'textarea'])
      .filter(({ tokens }) => !tokens.includes('focus-visible:border-ring'))
      .map(({ slot }) => slot);

    expect(missing).toEqual([]);
  });

  // A text field matches :focus-visible on a mouse click too, and the composer and the
  // command palette frame these two and draw focus themselves.
  it('the plain input and the textarea hide the base outline while focus-visible', () => {
    const found = controlsIn(['input', 'textarea']).map(({ slot, tokens }) => [
      slot,
      suppressions(tokens),
    ]);

    expect(found).toEqual([
      ['input', ['focus-visible:outline-hidden']],
      ['textarea', ['focus-visible:outline-hidden']],
    ]);
  });

  it('a control that hides its outline hides it only while focus-visible, so forced colors still paint one', () => {
    const offenders = renderEveryFocusableControl()
      .filter(({ tokens }) => {
        const found = suppressions(tokens);
        return found.length > 0 && found.join(' ') !== 'focus-visible:outline-hidden';
      })
      .map(({ slot }) => slot);

    expect(offenders).toEqual([]);
  });

  it('a control that hides its outline sets no focus outline width that would cancel it', () => {
    const offenders = renderEveryFocusableControl()
      .filter(
        ({ tokens }) =>
          tokens.includes('focus-visible:outline-hidden') &&
          tokens.some((token) => FOCUS_OUTLINE_WIDTH.test(token))
      )
      .map(({ slot }) => slot);

    expect(offenders).toEqual([]);
  });
});
