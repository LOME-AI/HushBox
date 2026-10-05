import { describe, it, expect, afterEach } from 'vitest';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { modeChipLabel } from '@/components/chat/input/mode-menu';
import {
  installComposerCues,
  isModeSwitchTarget,
  DEMO_COMPOSER_PLACEHOLDER,
} from './composer-cues';
import type { ChatModality } from '@hushbox/shared';

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

/** A radio menu item, carrying `testId` when the app gives it one. */
function mountRadioItem(title: string, testId?: string): HTMLElement {
  const item = document.createElement('div');
  item.setAttribute('role', 'menuitemradio');
  if (testId !== undefined) item.dataset['testid'] = testId;
  item.textContent = title;
  document.body.append(item);
  return item;
}

const MODALITIES: readonly ChatModality[] = ['text', 'image', 'video', 'audio'];

function cueCss(): string {
  const style = document.head.querySelector<HTMLStyleElement>(
    `style[data-testid="${TEST_IDS.demoComposerCues}"]`
  );
  if (style === null) throw new Error('no cue stylesheet');
  return style.textContent;
}

describe('installComposerCues', () => {
  it('replaces the placeholder with the demo copy', () => {
    const uninstall = installComposerCues();

    const css = cueCss();
    expect(css).toContain(DEMO_COMPOSER_PLACEHOLDER);
    expect(css).toContain('[data-testid="animated-placeholder"]::after');
    expect(css).toContain('[data-testid="animated-placeholder"] [data-testid="typing-animation"]');
    uninstall();
  });

  it.each(MODALITIES)('dims the %s mode while it is not the current one', (modality) => {
    const uninstall = installComposerCues();

    expect(cueCss()).toContain(
      `[data-testid="${TEST_ID_BUILDERS.modeMenuItem(modality)}"]:not([aria-checked="true"])`
    );
    uninstall();
  });

  it('marks the mode chip as locked', () => {
    const uninstall = installComposerCues();

    const css = cueCss();
    for (const modality of MODALITIES) {
      expect(css).toContain(`[aria-label="${modeChipLabel(modality)}"]`);
    }
    expect(css).not.toContain('aria-label^=');
    uninstall();
  });

  it('keys on no retired modality-switch label', () => {
    const uninstall = installComposerCues();

    expect(cueCss()).not.toContain('Switch to');
    uninstall();
  });

  it('removes the stylesheet when disposed', () => {
    const uninstall = installComposerCues();
    uninstall();
    expect(
      document.head.querySelector(`style[data-testid="${TEST_IDS.demoComposerCues}"]`)
    ).toBeNull();
  });
});

describe('isModeSwitchTarget', () => {
  it.each(MODALITIES)('matches the %s mode item, and an element inside it', (modality) => {
    const item = mountRadioItem('Any title', TEST_ID_BUILDERS.modeMenuItem(modality));
    const inner = document.createElement('span');
    item.append(inner);

    expect(isModeSwitchTarget(item)).toBe(true);
    expect(isModeSwitchTarget(inner)).toBe(true);
  });

  it('leaves a radio item with no mode test id alone, whatever its name', () => {
    const named = mountRadioItem('Image');

    expect(isModeSwitchTarget(named)).toBe(false);
  });

  it('matches the mode chip that returns the composer to text', () => {
    const chip = document.createElement('button');
    chip.setAttribute('aria-label', modeChipLabel('image'));
    document.body.append(chip);

    expect(isModeSwitchTarget(chip)).toBe(true);
  });

  it('leaves the "+" itself and other controls alone', () => {
    const button = document.createElement('button');
    button.dataset['testid'] = TEST_IDS.modeMenuButton;
    const darkMode = document.createElement('button');
    darkMode.setAttribute('aria-label', 'Switch to dark mode');
    document.body.append(button, darkMode);

    expect(isModeSwitchTarget(button)).toBe(false);
    expect(isModeSwitchTarget(darkMode)).toBe(false);
    expect(isModeSwitchTarget(null)).toBe(false);
  });
});
