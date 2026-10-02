// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { installThemeTokens } from '@/test-utils/theme-tokens.js';
import { SocialBanner } from './social-banner';

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    CipherWall: (props: Record<string, unknown>) => (
      <canvas data-testid={TEST_IDS.cipherWall} data-props={JSON.stringify(props)} />
    ),
  };
});

describe('SocialBanner', () => {
  // The banner refuses to paint under an unresolved token, so every case needs a
  // cascade even when it asserts nothing about colour. The blocks below layer
  // their own sheets on top of this one and outrank it.
  let removeThemeTokens: () => void;

  beforeEach(() => {
    removeThemeTokens = installThemeTokens();
  });

  afterEach(() => {
    removeThemeTokens();
  });

  it.each(['light', 'dark'] as const)('renders the container for the %s variant', (variant) => {
    render(<SocialBanner variant={variant} />);
    expect(screen.getByTestId(TEST_ID_BUILDERS.socialBanner(variant))).toBeInTheDocument();
  });

  it.each(['light', 'dark'] as const)('fills the viewport for the %s variant', (variant) => {
    render(<SocialBanner variant={variant} />);
    const container = screen.getByTestId(TEST_ID_BUILDERS.socialBanner(variant));
    // Read off the inline declaration: getComputedStyle resolves a relative
    // length to an absolute one, so toHaveStyle cannot assert a viewport unit.
    expect(container.style.width).toBe('100vw');
    expect(container.style.height).toBe('100vh');
  });

  it('applies the dark token scope only for the dark variant', () => {
    const { rerender } = render(<SocialBanner variant="dark" />);
    expect(screen.getByTestId(TEST_ID_BUILDERS.socialBanner('dark'))).toHaveClass('dark');
    rerender(<SocialBanner variant="light" />);
    expect(screen.getByTestId(TEST_ID_BUILDERS.socialBanner('light'))).not.toHaveClass('dark');
  });

  it('renders the wordmark with Hush in ink, Box in brand red, and the descriptor', () => {
    render(<SocialBanner variant="light" />);
    expect(screen.getByTestId(TEST_IDS.socialBannerWordmark)).toHaveClass('font-serif');
    expect(screen.getByText('Hush')).toHaveClass('text-foreground');
    expect(screen.getByText('Box')).toHaveClass('text-brand-red');
    expect(screen.getByText(/An AI chat interface/)).toBeInTheDocument();
  });

  it('leads with the privacy headliner in the editorial serif', () => {
    render(<SocialBanner variant="light" />);
    const headline = screen.getByTestId(TEST_IDS.socialBannerHeadline);
    expect(headline).toHaveTextContent('Privacy is a human right.');
    expect(headline).toHaveClass('font-serif');
    expect(headline).toHaveClass('text-foreground');
  });

  it('carries the brand tagline in the subline', () => {
    render(<SocialBanner variant="light" />);
    expect(screen.getByTestId(TEST_IDS.socialBannerSubline)).toHaveTextContent(
      'One interface. Every feature. Private.'
    );
  });

  it('shows the site url in the window chrome', () => {
    render(<SocialBanner variant="light" />);
    expect(screen.getByTestId(TEST_IDS.socialBannerUrl)).toHaveTextContent('hushbox.ai');
  });

  it.each(['light', 'dark'] as const)(
    'embeds the frozen %s demo on the welcome conversation, scrolled to top',
    (variant) => {
      render(<SocialBanner variant={variant} />);
      const iframe = screen.getByTestId(TEST_IDS.socialBannerPreview).querySelector('iframe');
      const source = iframe?.getAttribute('src') ?? '';
      expect(source).toContain('/demo?');
      expect(source).toContain('frozen=1');
      expect(source).toContain('convo=demo-welcome');
      expect(source).toContain('scroll=top');
      expect(source).toContain(`theme=${variant}`);
    }
  );

  it('passes a faint, frozen CipherWall backdrop with banner messages', () => {
    render(<SocialBanner variant="dark" />);
    const props = JSON.parse(screen.getByTestId(TEST_IDS.cipherWall).dataset['props'] ?? '{}');
    expect(props.frozen).toBe(true);
    expect(props.cipherOpacity).toBeLessThanOrEqual(0.5);
    expect(Array.isArray(props.messages)).toBe(true);
    expect(props.messages.length).toBeGreaterThan(0);
  });

  it('takes the canvas colors from the cascade it renders under, holding no palette of its own', () => {
    const sheet = document.createElement('style');
    sheet.textContent = `
      :root { --background: #010101; --foreground: #020202;
              --brand-red: #030303; --foreground-muted: #040404; }
      .dark { --background: #050505; --foreground: #060606;
              --brand-red: #070707; --foreground-muted: #080808; }
    `;
    document.head.append(sheet);

    render(<SocialBanner variant="dark" />);
    const props = JSON.parse(screen.getByTestId(TEST_IDS.cipherWall).dataset['props'] ?? '{}');

    expect(props.themeOverride).toEqual({
      background: '#050505',
      foreground: '#060606',
      brandRed: '#070707',
      foregroundMuted: '#080808',
    });
    sheet.remove();
  });

  it('marks itself ready only after the embedded demo signals it has painted', () => {
    render(<SocialBanner variant="light" />);
    expect(screen.queryByTestId(TEST_IDS.socialBannerReady)).toBeNull();

    act(() => {
      globalThis.dispatchEvent(new MessageEvent('message', { data: { type: 'hb-demo-ready' } }));
    });

    expect(screen.getByTestId(TEST_IDS.socialBannerReady)).toBeInTheDocument();
  });

  /**
   * The banner paints onto a canvas, which sits outside the cascade and needs
   * literal colors. It resolves them from the stylesheet at render time, so this
   * block stands up the real brand tokens — read out of
   * packages/config/tailwind/index.css — as the cascade the banner renders under,
   * and asserts the colors handed to CipherWall are those tokens.
   */
  describe('brand tokens resolved from the stylesheet', () => {
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const TOKEN_CSS = path.resolve(HERE, '../../../../../packages/config/tailwind/index.css');

    function cssToken(cssRegion: string, token: string): string {
      const match = new RegExp(String.raw`^\s*--${token}:\s*(#[0-9a-fA-F]{6});`, 'm').exec(
        cssRegion
      );
      if (!match?.[1]) throw new Error(`token --${token} not found in CSS region`);
      return match[1];
    }

    const css = readFileSync(TOKEN_CSS, 'utf8');
    const darkStart = css.indexOf('.dark {');
    const tokenRegion: Record<'light' | 'dark', string> = {
      light: css.slice(0, darkStart),
      dark: css.slice(darkStart),
    };

    function declarations(variant: 'light' | 'dark'): string {
      const region = tokenRegion[variant];
      return (['background', 'foreground', 'brand-red', 'foreground-muted'] as const)
        .map((token) => `--${token}: ${cssToken(region, token)};`)
        .join(' ');
    }

    let sheet: HTMLStyleElement;

    beforeEach(() => {
      sheet = document.createElement('style');
      // jsdom resolves a custom property only from rules matching the element
      // itself; it does not inherit one down to a descendant. `:root` therefore
      // cannot reach the light banner's wrapper here, and the universal selector
      // stands in for the inheritance a browser performs. `.dark` outranks it, so
      // the dark wrapper still resolves the dark block.
      sheet.textContent = `* { ${declarations('light')} } .dark { ${declarations('dark')} }`;
      document.head.append(sheet);
    });

    afterEach(() => {
      sheet.remove();
    });

    it.each(['light', 'dark'] as const)(
      'mirrors the %s brand tokens from tailwind index.css',
      (variant) => {
        render(<SocialBanner variant={variant} />);
        const props = JSON.parse(screen.getByTestId(TEST_IDS.cipherWall).dataset['props'] ?? '{}');
        expect(props.themeOverride).toEqual({
          background: cssToken(tokenRegion[variant], 'background'),
          foreground: cssToken(tokenRegion[variant], 'foreground'),
          foregroundMuted: cssToken(tokenRegion[variant], 'foreground-muted'),
          brandRed: cssToken(tokenRegion[variant], 'brand-red'),
        });
      }
    );
  });

  it('ignores window messages that are not the demo ready signal', () => {
    render(<SocialBanner variant="light" />);

    act(() => {
      globalThis.dispatchEvent(new MessageEvent('message', { data: null }));
      globalThis.dispatchEvent(new MessageEvent('message', { data: { type: 'something-else' } }));
    });

    expect(screen.queryByTestId(TEST_IDS.socialBannerReady)).toBeNull();
  });
});
