import { describe, it, expect } from 'vitest';
import * as lucideStatic from 'lucide-static';
import { lucideIconSvg } from './lucide-icon';

describe('lucideIconSvg', () => {
  it('returns the named icon, marked decorative', () => {
    const svg = lucideIconSvg('ShieldCheck');

    expect(svg).toContain('class="lucide lucide-shield-check"');
    expect(svg).toContain('<svg aria-hidden="true" focusable="false"');
  });

  it('throws naming the icon when no member carries that name', () => {
    expect(() => lucideIconSvg('NotAnIcon')).toThrow(/NotAnIcon/);
  });

  it('throws naming the icon when the member is not an icon string', () => {
    const nonIconNames = Object.entries(lucideStatic)
      .filter(([, value]) => typeof value !== 'string')
      .map(([name]) => name);
    expect(nonIconNames).toContain('default');

    expect(() => lucideIconSvg('default')).toThrow(/default/);
  });
});
