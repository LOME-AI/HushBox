/**
 * Demo-only composer cues that signal the chat box isn't a live input. Injects
 * one stylesheet that (1) replaces the per-modality placeholder ("Describe the
 * image you want...", etc.) with a sign-up prompt and (2) marks the mode
 * controls as locked: the modes the "+" menu offers besides the current one,
 * and the chip that returns the composer to text. Pure CSS — it touches no real
 * component and self-heals across re-renders.
 *
 * The director is unaffected: it switches modality with synthetic (untrusted)
 * presses that guardrails lets through, and types via the native value setter,
 * neither of which these visual-only rules block.
 */
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { modeChipLabel } from '@/components/chat/input/mode-menu';
import type { ChatModality } from '@hushbox/shared';

export const DEMO_COMPOSER_PLACEHOLDER = 'This is a live demo, sign up to start your own chats';

/** The composer's "+", which opens the mode menu. */
export const MODE_MENU_BUTTON_SELECTOR = `[data-testid="${TEST_IDS.modeMenuButton}"]`;

/** The mode menu's item for `modality`, present only while the menu is open. */
export function modeMenuItemSelector(modality: ChatModality): string {
  return `[data-testid="${TEST_ID_BUILDERS.modeMenuItem(modality)}"]`;
}

// Keyed by every modality, so a mode added to the union cannot go unselected here.
const MODE_ITEM_SELECTORS: Readonly<Record<ChatModality, string>> = {
  text: modeMenuItemSelector('text'),
  image: modeMenuItemSelector('image'),
  video: modeMenuItemSelector('video'),
  audio: modeMenuItemSelector('audio'),
};

/** Any item of the open mode menu. */
export const MODE_ITEM_SELECTOR = Object.values(MODE_ITEM_SELECTORS).join(',');

/** The chip that names `modality` as the current mode; it shows outside text only. */
export function modeChipSelector(modality: ChatModality): string {
  return `[aria-label="${modeChipLabel(modality)}"]`;
}

// Keyed by every modality, as the item selectors are.
const MODE_CHIP_SELECTORS: Readonly<Record<ChatModality, string>> = {
  text: modeChipSelector('text'),
  image: modeChipSelector('image'),
  video: modeChipSelector('video'),
  audio: modeChipSelector('audio'),
};

/** The mode chip, whichever mode it names. */
export const MODE_CHIP_SELECTOR = Object.values(MODE_CHIP_SELECTORS).join(',');

/** True if the target is (or is inside) a mode menu item, or the mode chip. */
export function isModeSwitchTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(`${MODE_ITEM_SELECTOR},${MODE_CHIP_SELECTOR}`) !== null;
}

// Hide the real animated placeholder text and overlay the demo copy via ::after
// (inheriting the overlay's muted color, font, and position). The overlay only
// mounts while the textarea is empty, so the copy disappears as the director
// types. The modes besides the current one take the ink the app's own locked
// modes take, and stay choosable for the director. Trusted choices are
// stopped by guardrails.
const COMPOSER_CUE_CSS = `
[data-testid="animated-placeholder"] [data-testid="typing-animation"] {
  display: none !important;
}
[data-testid="animated-placeholder"]::after {
  content: '${DEMO_COMPOSER_PLACEHOLDER}';
  position: absolute;
  top: 0;
  left: 0;
}
${Object.values(MODE_ITEM_SELECTORS)
  .map((selector) => `${selector}:not([aria-checked="true"])`)
  .join(',\n')} {
  color: var(--disabled-ink);
  cursor: not-allowed;
}
${MODE_CHIP_SELECTOR} {
  cursor: not-allowed;
}
`;

/** Inject the composer-cue stylesheet. Returns a disposer that removes it. */
export function installComposerCues(): () => void {
  const style = document.createElement('style');
  style.dataset['testid'] = TEST_IDS.demoComposerCues;
  style.textContent = COMPOSER_CUE_CSS;
  document.head.append(style);
  return () => {
    style.remove();
  };
}
