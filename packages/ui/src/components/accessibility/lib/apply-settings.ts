import { A11Y_CLASS_RULES, ruleValues } from './class-toggles';
import type { AccessibilityPreferences } from '@hushbox/shared';

export function applySettings(
  prefs: AccessibilityPreferences,
  root: HTMLElement = document.documentElement
): void {
  for (const rule of A11Y_CLASS_RULES) {
    root.classList.toggle(rule.className, ruleValues(rule).includes(prefs[rule.field]));
  }
  root.style.setProperty('--a11y-focus-width', `${prefs.focusWidth}px`);
  root.style.setProperty('--a11y-focus-color', prefs.focusColor);
}
