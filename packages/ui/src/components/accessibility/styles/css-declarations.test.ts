import { describe, it, expect } from 'vitest';

import { declaredValue } from './css-declarations';

describe('declaredValue', () => {
  it('reads a custom property out of the named selector', () => {
    expect(declaredValue(':root {\n  --prediction: #445566;\n}', ':root', '--prediction')).toBe(
      '#445566'
    );
  });

  it('drops the !important a tier override carries', () => {
    const css = 'html.a11y-contrast-high {\n  --foreground-muted: #111 !important;\n}';
    expect(declaredValue(css, 'html.a11y-contrast-high', '--foreground-muted')).toBe('#111');
  });

  it('reads past a nested ruleset instead of stopping at its closing brace', () => {
    const css = '.dark {\n  @layer base {\n    color: red;\n  }\n  --prediction: #778899;\n}';
    expect(declaredValue(css, '.dark', '--prediction')).toBe('#778899');
  });

  it('returns null for a property the selector only inherits', () => {
    expect(declaredValue(':root {\n  --other: #000;\n}', ':root', '--prediction')).toBeNull();
  });

  it('throws for a selector the stylesheet does not declare', () => {
    expect(() => declaredValue(':root {\n}', '.dark', '--prediction')).toThrow(
      'selector .dark not found'
    );
  });

  it('throws for a block the stylesheet never closes', () => {
    expect(() =>
      declaredValue(':root {\n  --prediction: #123456;', ':root', '--prediction')
    ).toThrow('selector :root is unterminated');
  });
});
