import { describe, it, expect } from 'vitest';
import {
  bannerMessageSchema,
  bannerConfigSchema,
  bannerResponseSchema,
  BANNER_VARIANTS,
  MAX_BANNER_MESSAGES,
  MAX_BANNER_TEXT_LENGTH,
} from './announcements.ts';

describe('bannerMessageSchema', () => {
  it('parses a minimal message (text only)', () => {
    expect(bannerMessageSchema.parse({ text: 'Switch models mid-conversation.' })).toEqual({
      text: 'Switch models mid-conversation.',
      variant: 'info',
    });
  });

  it('parses a full message', () => {
    const msg = {
      id: 'm1',
      text: 'Status update',
      variant: 'warning' as const,
      href: '/status',
      linkText: 'See status',
    };
    expect(bannerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('preserves each declared variant', () => {
    for (const variant of BANNER_VARIANTS) {
      expect(bannerMessageSchema.parse({ text: 'hi', variant }).variant).toBe(variant);
    }
  });

  it('salvages an unknown variant to info', () => {
    expect(bannerMessageSchema.parse({ text: 'hi', variant: 'explode' }).variant).toBe('info');
  });

  it('salvages a non-string variant to info', () => {
    expect(bannerMessageSchema.parse({ text: 'hi', variant: 7 }).variant).toBe('info');
  });

  it('trims surrounding whitespace in text', () => {
    expect(bannerMessageSchema.parse({ text: '  hello  ' }).text).toBe('hello');
  });

  it('rejects empty text', () => {
    expect(bannerMessageSchema.safeParse({ text: '' }).success).toBe(false);
  });

  it('rejects whitespace-only text', () => {
    expect(bannerMessageSchema.safeParse({ text: '   ' }).success).toBe(false);
  });

  it('rejects text over the max length', () => {
    expect(
      bannerMessageSchema.safeParse({ text: 'x'.repeat(MAX_BANNER_TEXT_LENGTH + 1) }).success
    ).toBe(false);
  });

  it('drops unknown fields', () => {
    const parsed = bannerMessageSchema.parse({ text: 'hi', secret: 'leak' });
    expect(parsed).not.toHaveProperty('secret');
  });

  it('keeps the message but strips an unsafe href to undefined', () => {
    const parsed = bannerMessageSchema.parse({ text: 'hi', href: 'javascript:alert(1)' });
    expect(parsed.text).toBe('hi');
    expect(parsed.href).toBeUndefined();
  });

  it('keeps a relative href', () => {
    expect(bannerMessageSchema.parse({ text: 'hi', href: '/pricing' }).href).toBe('/pricing');
  });

  it('keeps an http(s) absolute href', () => {
    expect(bannerMessageSchema.parse({ text: 'hi', href: 'https://hushbox.ai/status' }).href).toBe(
      'https://hushbox.ai/status'
    );
    expect(bannerMessageSchema.parse({ text: 'hi', href: 'http://example.com' }).href).toBe(
      'http://example.com'
    );
  });

  it('strips a data: href', () => {
    expect(
      bannerMessageSchema.parse({ text: 'hi', href: 'data:text/html,<script>' }).href
    ).toBeUndefined();
  });

  it('strips a protocol-relative href', () => {
    expect(
      bannerMessageSchema.parse({ text: 'hi', href: '//evil.example.com' }).href
    ).toBeUndefined();
  });

  it('strips a protocol-relative href naming the origin it resolves against', () => {
    expect(
      bannerMessageSchema.parse({ text: 'hi', href: '//relative.invalid/pwn' }).href
    ).toBeUndefined();
  });

  it('strips a backslash-folded href naming the origin it resolves against', () => {
    expect(
      bannerMessageSchema.parse({ text: 'hi', href: String.raw`/\relative.invalid/pwn` }).href
    ).toBeUndefined();
  });

  it('strips a percent-encoded href naming the origin it resolves against', () => {
    expect(
      bannerMessageSchema.parse({ text: 'hi', href: '//%72elative.invalid/pwn' }).href
    ).toBeUndefined();
  });

  it('strips a protocol-relative href naming the alternate origin it resolves against', () => {
    expect(
      bannerMessageSchema.parse({ text: 'hi', href: '//alternate.invalid/pwn' }).href
    ).toBeUndefined();
  });

  it('strips a backslash-prefixed href that resolves to another origin', () => {
    expect(
      bannerMessageSchema.parse({ text: 'hi', href: String.raw`/\evil.example.com` }).href
    ).toBeUndefined();
  });

  it('strips a backslash-prefixed href whose resolved authority is unparseable', () => {
    expect(bannerMessageSchema.parse({ text: 'hi', href: String.raw`/\[` }).href).toBeUndefined();
  });

  it('strips a tab-split href that resolves to another origin', () => {
    expect(
      bannerMessageSchema.parse({ text: 'hi', href: '/\t/evil.example.com' }).href
    ).toBeUndefined();
  });

  it('strips a newline-split href that resolves to another origin', () => {
    expect(
      bannerMessageSchema.parse({ text: 'hi', href: '/\n/evil.example.com' }).href
    ).toBeUndefined();
  });

  it('strips a double-backslash href', () => {
    expect(
      bannerMessageSchema.parse({ text: 'hi', href: String.raw`\\evil.example.com` }).href
    ).toBeUndefined();
  });

  it('strips an unparseable href', () => {
    expect(bannerMessageSchema.parse({ text: 'hi', href: 'not a url' }).href).toBeUndefined();
  });
});

describe('bannerConfigSchema (salvaging parse of an operator-edited row)', () => {
  it('parses a valid enabled config with per-message variants', () => {
    const cfg = bannerConfigSchema.parse({
      enabled: true,
      messages: [
        { text: 'one', variant: 'warning' },
        { text: 'two', variant: 'critical' },
      ],
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.messages).toEqual([
      { text: 'one', variant: 'warning' },
      { text: 'two', variant: 'critical' },
    ]);
  });

  it('has no top-level variant', () => {
    expect(
      bannerConfigSchema.parse({ enabled: true, variant: 'warning', messages: [] })
    ).not.toHaveProperty('variant');
  });

  it('salvages an unknown message variant to info', () => {
    const cfg = bannerConfigSchema.parse({
      enabled: true,
      messages: [{ text: 'one', variant: 'explode' }],
    });
    expect(cfg.messages[0]?.variant).toBe('info');
  });

  it('defaults a missing message variant to info', () => {
    const cfg = bannerConfigSchema.parse({ enabled: true, messages: [{ text: 'one' }] });
    expect(cfg.messages[0]?.variant).toBe('info');
  });

  it('coerces a non-boolean enabled to false (fail closed)', () => {
    expect(bannerConfigSchema.parse({ enabled: 'true', messages: [] }).enabled).toBe(false);
  });

  it('drops invalid messages but keeps the valid ones', () => {
    const cfg = bannerConfigSchema.parse({
      enabled: true,
      messages: [{ text: 'good one' }, { text: '' }, { nope: true }, { text: 'good two' }],
    });
    expect(cfg.messages.map((m) => m.text)).toEqual(['good one', 'good two']);
  });

  it('degrades messages that are not an array to an empty list', () => {
    expect(bannerConfigSchema.parse({ enabled: true, messages: 'oops' }).messages).toEqual([]);
  });

  it('degrades a non-object row to disabled', () => {
    expect(bannerConfigSchema.parse(null)).toEqual({
      enabled: false,
      messages: [],
      droppedCount: 0,
    });
    expect(bannerConfigSchema.parse('garbage')).toEqual({
      enabled: false,
      messages: [],
      droppedCount: 0,
    });
  });

  it('clamps to the maximum message count', () => {
    const messages = Array.from({ length: MAX_BANNER_MESSAGES + 5 }, (_, index) => ({
      text: `m${index.toString()}`,
    }));
    expect(bannerConfigSchema.parse({ enabled: true, messages }).messages).toHaveLength(
      MAX_BANNER_MESSAGES
    );
  });

  it('counts dropped invalid messages, and only those', () => {
    const cfg = bannerConfigSchema.parse({
      enabled: true,
      messages: [{ text: 'good' }, { text: '' }, { nope: true }],
    });
    expect(cfg.droppedCount).toBe(2);
  });

  it('reports no drops when a valid over-length set is truncated', () => {
    const messages = Array.from({ length: MAX_BANNER_MESSAGES + 5 }, (_, index) => ({
      text: `m${index.toString()}`,
    }));
    expect(bannerConfigSchema.parse({ enabled: true, messages }).droppedCount).toBe(0);
  });
});

describe('bannerResponseSchema (clean wire contract)', () => {
  it('parses a clean response with per-message variants', () => {
    const res = { hash: 'abc123', messages: [{ text: 'hi', variant: 'critical' as const }] };
    expect(bannerResponseSchema.parse(res)).toEqual(res);
  });

  it('has no top-level variant', () => {
    expect(
      bannerResponseSchema.parse({ hash: 'h', variant: 'warning', messages: [] })
    ).not.toHaveProperty('variant');
  });

  it('accepts a null hash (disabled)', () => {
    expect(bannerResponseSchema.parse({ hash: null, messages: [] }).hash).toBeNull();
  });

  it('rejects more than the maximum messages', () => {
    const messages = Array.from({ length: MAX_BANNER_MESSAGES + 1 }, () => ({ text: 'x' }));
    expect(bannerResponseSchema.safeParse({ hash: 'h', messages }).success).toBe(false);
  });
});

describe('BANNER_VARIANTS', () => {
  it('is the closed severity set', () => {
    expect([...BANNER_VARIANTS]).toEqual(['info', 'warning', 'critical']);
  });
});
