import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBrandColors, isCompleteTheme } from './brand.js';

const CSS_PATH = 'packages/config/tailwind/index.css';

function writeCss(root: string, css: string): void {
  const dir = path.join(root, 'packages/config/tailwind');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(root, CSS_PATH), css);
}

describe('getBrandColors', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'brand-test-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('parses light and dark themes from CSS', () => {
    writeCss(
      temporaryDir,
      `:root {
  --brand-red: #ec4755;
  --background: #faf9f6;
  --background-paper: #faf5ed;
  --foreground: #1a1a1a;
  --foreground-muted: #525252;
  --border: #e5e3de;
}
.dark {
  --brand-red: #ec4755;
  --background: #1a1816;
  --background-paper: #252320;
  --foreground: #f2f1ef;
  --foreground-muted: #9a9894;
  --border: #3d3a36;
}
`
    );

    const colors = getBrandColors(temporaryDir);

    expect(colors.light.brandRed).toBe('#ec4755');
    expect(colors.light.background).toBe('#faf9f6');
    expect(colors.light.foreground).toBe('#1a1a1a');
    expect(colors.dark.background).toBe('#1a1816');
    expect(colors.dark.foreground).toBe('#f2f1ef');
  });

  // The shortest and longest CSS hex colours, pinning both ends of the colour
  // pattern's length bound; the long form also spans the digit, lower-case and
  // upper-case ends of the pattern's character class.
  it('parses a three-digit colour value', () => {
    writeCss(
      temporaryDir,
      `:root {
  --brand-red: #0af;
  --background: #faf9f6;
  --background-paper: #faf5ed;
  --foreground: #1a1a1a;
  --foreground-muted: #525252;
  --border: #e5e3de;
}
.dark {
  --brand-red: #ec4755;
  --background: #1a1816;
  --background-paper: #252320;
  --foreground: #f2f1ef;
  --foreground-muted: #9a9894;
  --border: #3d3a36;
}
`
    );

    expect(getBrandColors(temporaryDir).light.brandRed).toBe('#0af');
  });

  it('parses an eight-digit colour value in full', () => {
    writeCss(
      temporaryDir,
      `:root {
  --brand-red: #09afAF80;
  --background: #faf9f6;
  --background-paper: #faf5ed;
  --foreground: #1a1a1a;
  --foreground-muted: #525252;
  --border: #e5e3de;
}
.dark {
  --brand-red: #ec4755;
  --background: #1a1816;
  --background-paper: #252320;
  --foreground: #f2f1ef;
  --foreground-muted: #9a9894;
  --border: #3d3a36;
}
`
    );

    expect(getBrandColors(temporaryDir).light.brandRed).toBe('#09afAF80');
  });

  it('throws when the CSS file is missing', () => {
    expect(() => getBrandColors(temporaryDir)).toThrow();
  });

  it('defaults to process.cwd() when no root is given', () => {
    writeCss(
      temporaryDir,
      `:root {
  --brand-red: #ec4755;
  --background: #faf9f6;
  --background-paper: #faf5ed;
  --foreground: #1a1a1a;
  --foreground-muted: #525252;
  --border: #e5e3de;
}
.dark {
  --brand-red: #ec4755;
  --background: #1a1816;
  --background-paper: #252320;
  --foreground: #f2f1ef;
  --foreground-muted: #9a9894;
  --border: #3d3a36;
}
`
    );
    const originalCwd = process.cwd();
    process.chdir(temporaryDir);
    try {
      expect(getBrandColors()).toEqual(getBrandColors(temporaryDir));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('throws when the :root block is missing', () => {
    writeCss(temporaryDir, `.dark { --brand-red: #ec4755; }`);

    expect(() => getBrandColors(temporaryDir)).toThrow(':root');
  });

  it('throws when the .dark block is missing', () => {
    writeCss(
      temporaryDir,
      `:root {
  --brand-red: #ec4755;
  --background: #faf9f6;
  --background-paper: #faf5ed;
  --foreground: #1a1a1a;
  --foreground-muted: #525252;
  --border: #e5e3de;
}
`
    );

    expect(() => getBrandColors(temporaryDir)).toThrow('.dark');
  });

  it('lists missing properties in error message', () => {
    writeCss(
      temporaryDir,
      `:root {
  --brand-red: #ec4755;
}
.dark {
  --brand-red: #ec4755;
  --background: #1a1816;
  --background-paper: #252320;
  --foreground: #f2f1ef;
  --foreground-muted: #9a9894;
  --border: #3d3a36;
}
`
    );

    expect(() => getBrandColors(temporaryDir)).toThrow(/--background/);
  });

  it('reads from the real project CSS file', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const colors = getBrandColors(repoRoot);

    expect(colors.light.brandRed).toMatch(/^#[0-9a-f]{6}$/i);
    expect(colors.dark.brandRed).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('isCompleteTheme', () => {
  const complete = {
    brandRed: '#ec4755',
    background: '#faf9f6',
    backgroundPaper: '#faf5ed',
    foreground: '#1a1a1a',
    foregroundMuted: '#525252',
    border: '#e5e3de',
  };

  it('accepts a theme carrying every colour the generators read', () => {
    expect(isCompleteTheme(complete)).toBe(true);
  });

  it('rejects a theme whose border colour never parsed', () => {
    const { brandRed, background, backgroundPaper, foreground, foregroundMuted } = complete;

    expect(
      isCompleteTheme({ brandRed, background, backgroundPaper, foreground, foregroundMuted })
    ).toBe(false);
  });
});
