import * as React from 'react';

export interface Hotkey {
  /**
   * Modifiers plus one key, `+`-joined and case-insensitive: `mod+k`,
   * `shift+alt+n`, `escape`. `mod` is Meta on Apple platforms and Control
   * everywhere else; the other modifiers are `meta`, `ctrl`, `alt`, `shift`.
   */
  readonly combo: string;
  /** What the shortcut does, for a help overlay. */
  readonly description: string;
  readonly onTrigger: (event: KeyboardEvent) => void;
  /**
   * Also fires while focus is in a text field. Only a combo holding `mod`,
   * `ctrl` or `meta` may declare it, since any other key is text being typed;
   * registering any other combo with it throws. On Apple platforms `mod` takes
   * Meta alone there, leaving Ctrl to the system's text bindings (Ctrl+K deletes
   * to the end of the line).
   */
  readonly whileTyping?: boolean;
}

/** A registered shortcut, as a help overlay needs to render it. */
export interface HotkeyBinding {
  readonly combo: string;
  readonly description: string;
}

interface UseHotkeysOptions {
  /** Registered only while true. Defaults to true. */
  readonly enabled?: boolean;
}

interface ParsedCombo {
  readonly key: string;
  readonly mod: boolean;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

function parseCombo(combo: string): ParsedCombo {
  const lowered = combo.toLowerCase();
  const lastSeparator = lowered.lastIndexOf('+');
  const key = lowered.slice(lastSeparator + 1);
  const modifiers = new Set(lastSeparator === -1 ? [] : lowered.slice(0, lastSeparator).split('+'));
  return {
    key,
    mod: modifiers.has('mod'),
    meta: modifiers.has('meta'),
    ctrl: modifiers.has('ctrl'),
    alt: modifiers.has('alt'),
    shift: modifiers.has('shift'),
  };
}

/** True on macOS and iOS, where `mod` is Command and the glyphs are Apple's. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
}

function holdsAccelerator(combo: string): boolean {
  const parsed = parseCombo(combo);
  return parsed.mod || parsed.ctrl || parsed.meta;
}

function assertWhileTypingAllowed(hotkey: Hotkey): void {
  if (hotkey.whileTyping === true && !holdsAccelerator(hotkey.combo)) {
    throw new Error(
      `useHotkeys: '${hotkey.combo}' declares whileTyping but holds neither Ctrl nor Meta, so it would take keystrokes meant for the text field`
    );
  }
}

function acceleratorMatches(
  parsed: ParsedCombo,
  event: KeyboardEvent,
  commandOnly: boolean
): boolean {
  if (!parsed.mod) {
    return event.metaKey === parsed.meta && event.ctrlKey === parsed.ctrl;
  }
  if (commandOnly) {
    return event.metaKey && !event.ctrlKey;
  }
  // Either accelerator satisfies `mod`, so neither is checked exactly.
  return event.metaKey || event.ctrlKey;
}

function matchesCombo(combo: string, event: KeyboardEvent, commandOnly: boolean): boolean {
  const parsed = parseCombo(combo);
  return (
    event.key.toLowerCase() === parsed.key &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift &&
    acceleratorMatches(parsed, event, commandOnly)
  );
}

/**
 * True when the event came from somewhere the user is entering text. A shortcut
 * never steals a keystroke from typing unless it opts in with `whileTyping`,
 * which only an accelerator combo may — the guard every hand-wired listener in
 * this repo needed and mostly lacked.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    // `isContentEditable` is the case-insensitive, every-value definition, so it is
    // what catches `plaintext-only` and an uppercase `TRUE`. The attribute walk is not
    // redundant with it: happy-dom resolves a valueless `contenteditable` to `inherit`,
    // leaving `isContentEditable` false there, and the walk is also the only thing that
    // keeps the guard on inside a `contenteditable="false"` island within an editing host.
    target.isContentEditable ||
    target.closest('[contenteditable="true"], [contenteditable=""]') !== null
  );
}

/**
 * Registers keyboard shortcuts for as long as the caller is mounted and enabled,
 * and returns the bindings so a help overlay can render the same list the
 * handler dispatches on.
 */
export function useHotkeys(
  hotkeys: readonly Hotkey[],
  options?: UseHotkeysOptions
): readonly HotkeyBinding[] {
  const enabled = options?.enabled ?? true;
  for (const hotkey of hotkeys) {
    assertWhileTypingAllowed(hotkey);
  }
  const hotkeysRef = React.useRef(hotkeys);

  React.useEffect(() => {
    hotkeysRef.current = hotkeys;
  });

  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent): void {
      const typing = isTextEntryTarget(event.target);
      const commandOnly = typing && isApplePlatform();
      const match = hotkeysRef.current.find(
        (candidate) =>
          (!typing || candidate.whileTyping === true) &&
          matchesCombo(candidate.combo, event, commandOnly)
      );
      if (match !== undefined) {
        event.preventDefault();
        match.onTrigger(event);
      }
    }
    globalThis.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled]);

  return hotkeys.map(({ combo, description }) => ({ combo, description }));
}
