import * as React from 'react';

import { isApplePlatform } from '../../hooks/use-hotkeys';
import { cn } from '../../lib/utilities';

const APPLE_MODIFIERS: Readonly<Record<string, string>> = {
  mod: '⌘',
  meta: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
};

const WORD_MODIFIERS: Readonly<Record<string, string>> = {
  mod: 'Ctrl',
  meta: 'Meta',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
};

/** The references' hint form off Apple: words, except Shift, which is its glyph. */
const TEXT_MODIFIERS: Readonly<Record<string, string>> = {
  ...WORD_MODIFIERS,
  shift: '⇧',
};

const KEYCAP_CLASSES =
  'text-muted-foreground border-border inline-flex items-center rounded border bg-transparent px-[0.4em] py-[0.2em] font-mono text-xs leading-none';

const KEYBOARD_ONLY_CLASSES = 'max-md:hidden pointer-coarse:hidden';

type KbdForm = 'text' | 'keycaps' | 'joined';

function capitalize(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** A combo's modifiers named from `table`, then its key, capitalized. */
function comboParts(combo: string, table: Readonly<Record<string, string>>): string[] {
  const parts = combo.toLowerCase().split('+');
  return parts.map((part, index) => {
    const isKey = index === parts.length - 1;
    return isKey ? capitalize(part) : (table[part] ?? capitalize(part));
  });
}

/**
 * A `useHotkeys` combo as the platform writes it: glyphs run together on Apple
 * platforms (`⌘K`), `+`-joined words everywhere else (`Ctrl+K`).
 */
function formatHotkey(combo: string, options: { readonly apple: boolean }): string {
  const parts = comboParts(combo, options.apple ? APPLE_MODIFIERS : WORD_MODIFIERS);
  return parts.join(options.apple ? '' : '+');
}

/**
 * A keyboard shortcut, rendered in a real `<kbd>`. The element name is what the
 * accessibility font override's carve-out selects, so the `font-mono` class alone
 * would not survive that override. A hint is for keyboards, so by default it hides
 * on phone widths and touch pointers. The border names its colour because the base layer's
 * default border resolves at the root, which is wrong inside a `.dark` subtree.
 *
 * `joined` is {@link formatHotkey}'s string. `text` spaces the parts off Apple
 * (`Ctrl ⇧ O`) and keeps the joined glyphs on Apple. `keycaps` boxes each part
 * as its own `<kbd>` inside the combination's, the HTML form of a key combination.
 */
function Kbd({
  combo,
  form = 'joined',
  alwaysVisible = false,
  className,
  ...props
}: Readonly<
  React.ComponentProps<'kbd'> & {
    combo: string;
    form?: KbdForm;
    /** Shows the key at every width and pointer, where the key is the content and not a hint. */
    alwaysVisible?: boolean;
  }
>): React.JSX.Element {
  const apple = isApplePlatform();
  const visibility = alwaysVisible ? undefined : KEYBOARD_ONLY_CLASSES;
  // The shared stylesheet's base layer hides every `kbd` on phones and touch
  // pointers with `!important`; this attribute is the one thing that rule skips.
  const shown = alwaysVisible ? '' : undefined;
  if (form === 'keycaps') {
    const caps = comboParts(combo, apple ? APPLE_MODIFIERS : TEXT_MODIFIERS);
    return (
      <kbd
        data-slot="kbd"
        data-always-visible={shown}
        className={cn('inline-flex items-center gap-1.5', visibility, className)}
        {...props}
      >
        {caps.map((cap) => (
          <kbd key={cap} data-always-visible={shown} className={KEYCAP_CLASSES}>
            {cap}
          </kbd>
        ))}
      </kbd>
    );
  }
  const label =
    form === 'text' && !apple
      ? comboParts(combo, TEXT_MODIFIERS).join(' ')
      : formatHotkey(combo, { apple });
  return (
    <kbd
      data-slot="kbd"
      data-always-visible={shown}
      className={cn(KEYCAP_CLASSES, visibility, className)}
      {...props}
    >
      {label}
    </kbd>
  );
}

export { Kbd, formatHotkey };
