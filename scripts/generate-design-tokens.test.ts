import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as DESIGN_TOKENS from '@hushbox/shared/design-tokens';
import {
  STYLESHEET,
  blockIsCurrent,
  generateDesignTokens,
  renderTokenBlock,
  replaceTokenBlock,
  type TokenSource,
} from './generate-design-tokens.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const committedStylesheet = readFileSync(path.join(REPO_ROOT, STYLESHEET), 'utf8');

/** The smallest source that exercises every section the block renders. */
const FIXTURE: TokenSource = {
  THEME_COLOURS: {
    light: { '--ink': '#111111', '--paper': '#fefefe' },
    dark: { '--ink': '#eeeeee', '--paper': '#010101' },
  },
  THEME_ALIASES: { primary: 'var(--ink)', 'primary-foreground': '#ffffff' },
  FONT_FAMILIES: { sans: 'Grotesk, sans-serif' },
  RADIUS: { base: '0.5rem', steps: { lg: 'var(--radius)' } },
  APP_HEADER_HEIGHT: '3rem',
  MOTION: { fastMs: 150, baseMs: 200, slowMs: 300, deliberateMs: 500 },
  Z: { sticky: 20, overlay: 70 },
  TYPE_ROLES: {
    title: { size: '1.5rem', lineHeight: '1.25', weight: 700, tracking: '-0.02em' },
    reading: {
      size: '1rem',
      lineHeight: '1.7',
      weight: 400,
      fromDesktop: { size: '1.0625rem', lineHeight: '1.7' },
    },
  },
  LAYOUT: {
    bandPx: 768,
    buttonRule: {
      fullWidthMax: '40rem',
      minWidth: '12rem',
      stackTwoBelow: '18rem',
      stackManyBelow: '28rem',
    },
    containers: { pane: '34rem' },
  },
};

const FIXTURE_GOLDEN = `/* Generated from packages/shared/src/design/tokens.ts by \`pnpm generate:design-tokens\`.
   Edit that module and regenerate; a hand edit here fails the token freshness test. */
:root {
  --ink: #111111;
  --paper: #fefefe;
  --radius: 0.5rem;
  --app-header-height: 3rem;
}

.dark {
  --ink: #eeeeee;
  --paper: #010101;
}

@theme inline {
  --font-sans: Grotesk, sans-serif;

  --color-ink: var(--ink);
  --color-paper: var(--paper);

  --color-primary: var(--ink);
  --color-primary-foreground: #ffffff;

  --radius-lg: var(--radius);
}

@theme {
  --motion-fast: 150ms;
  --motion-base: 200ms;
  --motion-slow: 300ms;
  --motion-deliberate: 500ms;

  --btn-full-max: 40rem;
  --btn-min: 12rem;
  --btn-stack-two: 18rem;
  --btn-stack-many: 28rem;

  --text-title: 1.5rem;
  --text-title--line-height: 1.25;
  --text-title--font-weight: 700;
  --text-title--letter-spacing: -0.02em;
  --text-reading: 1rem;
  --text-reading--line-height: 1.7;
  --text-reading--font-weight: 400;

  --container-pane: 34rem;
}

@media (width >= 48rem) {
  :root {
    --text-reading: 1.0625rem;
    --text-reading--line-height: 1.7;
  }
}

@utility z-sticky {
  z-index: 20;
}

@utility z-overlay {
  z-index: 70;
}
`;

describe('renderTokenBlock', () => {
  it('renders a token source as the golden block', () => {
    expect(renderTokenBlock(FIXTURE)).toBe(FIXTURE_GOLDEN);
  });

  it('renders a role with a desktop step as its 768 override', () => {
    expect(renderTokenBlock(FIXTURE)).toContain(
      '@media (width >= 48rem) {\n  :root {\n    --text-reading: 1.0625rem;\n'
    );
  });

  it('renders no desktop override when no role steps at 768', () => {
    const flat = Object.fromEntries(
      Object.entries(FIXTURE.TYPE_ROLES).filter(([role]) => role !== 'reading')
    );
    expect(renderTokenBlock({ ...FIXTURE, TYPE_ROLES: flat })).not.toContain('@media');
  });
});

describe('replaceTokenBlock', () => {
  const stylesheet = `@import 'x';\n/* BEGIN GENERATED: design-tokens */\nold\n/* END GENERATED: design-tokens */\n.kept { color: red; }\n`;

  it('rewrites only the text between the markers', () => {
    expect(replaceTokenBlock(stylesheet, 'new\n')).toBe(
      `@import 'x';\n/* BEGIN GENERATED: design-tokens */\nnew\n/* END GENERATED: design-tokens */\n.kept { color: red; }\n`
    );
  });

  it('refuses a stylesheet that has lost its markers', () => {
    expect(() => replaceTokenBlock('.kept { color: red; }\n', 'new\n')).toThrow(
      /BEGIN GENERATED: design-tokens/
    );
  });
});

describe('the committed token block', () => {
  it('is the render of the token module', () => {
    expect(
      blockIsCurrent(committedStylesheet, DESIGN_TOKENS),
      `${STYLESHEET} is stale: run \`pnpm generate:design-tokens\``
    ).toBe(true);
  });

  it('is refused once one value in it is altered', () => {
    const altered = committedStylesheet.replace('--brand-red: #ec4755;', '--brand-red: #ec4756;');
    expect(altered).not.toBe(committedStylesheet);
    expect(blockIsCurrent(altered, DESIGN_TOKENS)).toBe(false);
  });
});

describe('generateDesignTokens', () => {
  let root: string;
  const stylesheetPath = (): string => path.join(root, STYLESHEET);

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'design-tokens-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seed(css: string): void {
    mkdirSync(path.dirname(stylesheetPath()), { recursive: true });
    writeFileSync(stylesheetPath(), css);
  }

  it('writes a stale block and reports that it did', () => {
    seed('/* BEGIN GENERATED: design-tokens */\nstale\n/* END GENERATED: design-tokens */\n');
    expect(generateDesignTokens({ repoRoot: root, tokens: FIXTURE })).toBe(true);
    expect(readFileSync(stylesheetPath(), 'utf8')).toContain(FIXTURE_GOLDEN);
  });

  it('leaves a current stylesheet untouched', () => {
    seed(
      replaceTokenBlock(
        '/* BEGIN GENERATED: design-tokens */\n/* END GENERATED: design-tokens */\n',
        FIXTURE_GOLDEN
      )
    );
    expect(generateDesignTokens({ repoRoot: root, tokens: FIXTURE })).toBe(false);
  });
});
