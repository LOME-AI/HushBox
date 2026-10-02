import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { typeRoleClass } from './type-role-class';

const STYLESHEET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../config/tailwind/index.css'
);
const BEGIN = '/* BEGIN GENERATED: design-tokens */';
const END = '/* END GENERATED: design-tokens */';

function tokenBlock(): string {
  const css = readFileSync(STYLESHEET, 'utf8');
  const start = css.indexOf(BEGIN);
  const end = css.indexOf(END, start);
  if (start === -1 || end === -1) throw new Error(`${STYLESHEET} has no token block markers`);
  return css.slice(start + BEGIN.length, end);
}

/** The declarations of the block's one match for `pattern`, whose first group is a rule body. */
function ruleBody(pattern: RegExp): string {
  const match = pattern.exec(tokenBlock());
  if (match?.[1] === undefined)
    throw new Error(`the token block has no match for ${pattern.source}`);
  return match[1];
}

describe('typeRoleClass', () => {
  it('sets the site title role through its generated utility in the serif face', () => {
    expect(typeRoleClass('site-title')).toBe('text-site-title font-serif');
  });

  it('sets the auth title role through its generated utility in the serif face', () => {
    expect(typeRoleClass('auth-title')).toBe('text-auth-title font-serif');
  });

  it('sets the header title role through its generated utility in the sans face', () => {
    expect(typeRoleClass('header-title')).toBe('text-header-title font-sans');
  });

  it('sets the chat greeting role through its generated utility in the serif face', () => {
    expect(typeRoleClass('chat-greeting')).toBe('text-chat-greeting font-serif');
  });

  it('sets the snug ui role through its generated utility in the sans face', () => {
    expect(typeRoleClass('ui-snug')).toBe('text-ui-snug font-sans');
  });

  it('sets the site trust role through its generated utility in the serif face', () => {
    expect(typeRoleClass('site-trust')).toBe('text-site-trust font-serif');
  });

  it('sets the site card title role through its generated utility in the serif face', () => {
    expect(typeRoleClass('site-card-title')).toBe('text-site-card-title font-serif');
  });

  it('sets the small mono role through its generated utility in the mono face', () => {
    expect(typeRoleClass('mono-sm')).toBe('text-mono-sm font-mono');
  });

  it('sets the site cipher role through its generated utility in the mono face', () => {
    expect(typeRoleClass('site-cipher')).toBe('text-site-cipher font-mono');
  });
});

describe('the chat greeting utility', () => {
  it('carries its phone size, leading, weight and tracking in the theme', () => {
    const theme = ruleBody(/\n@theme \{\n([\s\S]*?)\n\}\n/);

    expect(theme).toContain(
      [
        '  --text-chat-greeting: 1.875rem;',
        '  --text-chat-greeting--line-height: 1.2;',
        '  --text-chat-greeting--font-weight: 700;',
        '  --text-chat-greeting--letter-spacing: -0.025em;',
      ].join('\n')
    );
  });

  it('steps to its desktop size and leading from 768', () => {
    const desktop = ruleBody(
      /\n@media \(width >= 48rem\) \{\n {2}:root \{\n([\s\S]*?)\n {2}\}\n\}\n/
    );

    expect(desktop).toContain(
      ['    --text-chat-greeting: 2.75rem;', '    --text-chat-greeting--line-height: 1.15;'].join(
        '\n'
      )
    );
  });
});

describe('the site title utility', () => {
  it('carries its phone size, leading, weight and tracking in the theme', () => {
    const theme = ruleBody(/\n@theme \{\n([\s\S]*?)\n\}\n/);

    expect(theme).toContain(
      [
        '  --text-site-title: 1.875rem;',
        '  --text-site-title--line-height: 1.2;',
        '  --text-site-title--font-weight: 700;',
        '  --text-site-title--letter-spacing: -0.025em;',
      ].join('\n')
    );
  });

  it('steps to its desktop size and leading from 768', () => {
    const desktop = ruleBody(
      /\n@media \(width >= 48rem\) \{\n {2}:root \{\n([\s\S]*?)\n {2}\}\n\}\n/
    );

    expect(desktop).toContain(
      ['    --text-site-title: 2.25rem;', '    --text-site-title--line-height: 1.111;'].join('\n')
    );
  });
});

describe('the auth title utility', () => {
  it('carries its size, leading and weight in the theme', () => {
    const theme = ruleBody(/\n@theme \{\n([\s\S]*?)\n\}\n/);

    expect(theme).toContain(
      [
        '  --text-auth-title: 1.875rem;',
        '  --text-auth-title--line-height: 1.2;',
        '  --text-auth-title--font-weight: 700;',
      ].join('\n')
    );
  });

  it('sets no tracking', () => {
    expect(tokenBlock()).not.toContain('--text-auth-title--letter-spacing');
  });

  it('keeps one size from 768', () => {
    const desktop = ruleBody(
      /\n@media \(width >= 48rem\) \{\n {2}:root \{\n([\s\S]*?)\n {2}\}\n\}\n/
    );

    expect(desktop).not.toContain('--text-auth-title');
  });
});

describe('the header title utility', () => {
  it('carries its size, leading and weight in the theme', () => {
    const theme = ruleBody(/\n@theme \{\n([\s\S]*?)\n\}\n/);

    expect(theme).toContain(
      [
        '  --text-header-title: 0.875rem;',
        '  --text-header-title--line-height: 1.25;',
        '  --text-header-title--font-weight: 500;',
      ].join('\n')
    );
  });

  it('sets no tracking', () => {
    expect(tokenBlock()).not.toContain('--text-header-title--letter-spacing');
  });

  it('keeps one size from 768', () => {
    const desktop = ruleBody(
      /\n@media \(width >= 48rem\) \{\n {2}:root \{\n([\s\S]*?)\n {2}\}\n\}\n/
    );

    expect(desktop).not.toContain('--text-header-title');
  });
});

describe('the snug ui utility', () => {
  it('carries its size, leading and weight in the theme', () => {
    const theme = ruleBody(/\n@theme \{\n([\s\S]*?)\n\}\n/);

    expect(theme).toContain(
      [
        '  --text-ui-snug: 0.875rem;',
        '  --text-ui-snug--line-height: 1.35;',
        '  --text-ui-snug--font-weight: 400;',
      ].join('\n')
    );
  });

  it('sets no tracking', () => {
    expect(tokenBlock()).not.toContain('--text-ui-snug--letter-spacing');
  });

  it('keeps one size from 768', () => {
    const desktop = ruleBody(
      /\n@media \(width >= 48rem\) \{\n {2}:root \{\n([\s\S]*?)\n {2}\}\n\}\n/
    );

    expect(desktop).not.toContain('--text-ui-snug');
  });
});

describe('the site trust utility', () => {
  it('carries its size, leading and weight in the theme', () => {
    const theme = ruleBody(/\n@theme \{\n([\s\S]*?)\n\}\n/);

    expect(theme).toContain(
      [
        '  --text-site-trust: 1rem;',
        '  --text-site-trust--line-height: 1.5;',
        '  --text-site-trust--font-weight: 600;',
      ].join('\n')
    );
  });

  it('sets no tracking', () => {
    expect(tokenBlock()).not.toContain('--text-site-trust--letter-spacing');
  });

  it('keeps one size from 768', () => {
    const desktop = ruleBody(
      /\n@media \(width >= 48rem\) \{\n {2}:root \{\n([\s\S]*?)\n {2}\}\n\}\n/
    );

    expect(desktop).not.toContain('--text-site-trust');
  });
});

describe('the site card title utility', () => {
  it('carries its size, leading and weight in the theme', () => {
    const theme = ruleBody(/\n@theme \{\n([\s\S]*?)\n\}\n/);

    expect(theme).toContain(
      [
        '  --text-site-card-title: 1rem;',
        '  --text-site-card-title--line-height: 1.4;',
        '  --text-site-card-title--font-weight: 600;',
      ].join('\n')
    );
  });

  it('sets no tracking', () => {
    expect(tokenBlock()).not.toContain('--text-site-card-title--letter-spacing');
  });

  it('keeps one size from 768', () => {
    const desktop = ruleBody(
      /\n@media \(width >= 48rem\) \{\n {2}:root \{\n([\s\S]*?)\n {2}\}\n\}\n/
    );

    expect(desktop).not.toContain('--text-site-card-title');
  });
});

describe('the small mono utility', () => {
  it('carries its size, leading and weight in the theme', () => {
    const theme = ruleBody(/\n@theme \{\n([\s\S]*?)\n\}\n/);

    expect(theme).toContain(
      [
        '  --text-mono-sm: 0.75rem;',
        '  --text-mono-sm--line-height: 1.43;',
        '  --text-mono-sm--font-weight: 400;',
      ].join('\n')
    );
  });

  it('sets no tracking', () => {
    expect(tokenBlock()).not.toContain('--text-mono-sm--letter-spacing');
  });

  it('keeps one size from 768', () => {
    const desktop = ruleBody(
      /\n@media \(width >= 48rem\) \{\n {2}:root \{\n([\s\S]*?)\n {2}\}\n\}\n/
    );

    expect(desktop).not.toContain('--text-mono-sm');
  });
});

describe('the site cipher utility', () => {
  it('carries its size, leading and weight in the theme', () => {
    const theme = ruleBody(/\n@theme \{\n([\s\S]*?)\n\}\n/);

    expect(theme).toContain(
      [
        '  --text-site-cipher: 0.8125rem;',
        '  --text-site-cipher--line-height: 1.55;',
        '  --text-site-cipher--font-weight: 400;',
      ].join('\n')
    );
  });

  it('sets no tracking', () => {
    expect(tokenBlock()).not.toContain('--text-site-cipher--letter-spacing');
  });

  it('keeps one size from 768', () => {
    const desktop = ruleBody(
      /\n@media \(width >= 48rem\) \{\n {2}:root \{\n([\s\S]*?)\n {2}\}\n\}\n/
    );

    expect(desktop).not.toContain('--text-site-cipher');
  });
});
