import { describe, it, expect } from 'vitest';
import { TYPE_ROLES } from '@hushbox/shared/design-tokens';
import { cn } from './utilities';

const ROLE_CLASSES = Object.keys(TYPE_ROLES).map((role) => `text-${role}`);

describe('cn', () => {
  it('keeps a type-role class beside a text colour class', () => {
    expect(cn('text-caption text-muted-foreground')).toBe('text-caption text-muted-foreground');
  });

  it('resolves two type-role classes to the last', () => {
    expect(cn('text-caption text-title-1')).toBe('text-title-1');
  });

  it('resolves the site title class and a stock size class to the last', () => {
    expect(cn('text-site-title', 'text-lg')).toBe('text-lg');
  });

  it('resolves the auth title class and a stock size class to the last', () => {
    expect(cn('text-auth-title', 'text-lg')).toBe('text-lg');
  });

  it('resolves the header title class and a stock size class to the last', () => {
    expect(cn('text-header-title', 'text-lg')).toBe('text-lg');
  });

  it('resolves the chat greeting class and a stock size class to the last', () => {
    expect(cn('text-chat-greeting', 'text-lg')).toBe('text-lg');
  });

  it('resolves the snug ui class and a stock size class to the last', () => {
    expect(cn('text-ui-snug', 'text-lg')).toBe('text-lg');
  });

  it('resolves the site trust class and a stock size class to the last', () => {
    expect(cn('text-site-trust', 'text-lg')).toBe('text-lg');
  });

  it('resolves the site card title class and a stock size class to the last', () => {
    expect(cn('text-site-card-title', 'text-lg')).toBe('text-lg');
  });

  it('resolves the small mono class and a stock size class to the last', () => {
    expect(cn('text-mono-sm', 'text-lg')).toBe('text-lg');
  });

  it('resolves the site cipher class and a stock size class to the last', () => {
    expect(cn('text-site-cipher', 'text-lg')).toBe('text-lg');
  });

  it.each(ROLE_CLASSES)('keeps %s beside a text colour class', (roleClass) => {
    expect(cn(roleClass, 'text-muted-foreground')).toBe(`${roleClass} text-muted-foreground`);
  });
});
