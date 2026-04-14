import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface ThemeColors {
  brandRed: string;
  background: string;
  backgroundPaper: string;
  foreground: string;
  foregroundMuted: string;
  border: string;
}

export interface BrandColors {
  light: ThemeColors;
  dark: ThemeColors;
}

const CSS_PATH_FROM_REPO_ROOT = 'packages/config/tailwind/index.css';

/**
 * Extract a specific CSS custom property value from a block of CSS text.
 * Returns undefined if the property is not found in the block.
 */
function extractProperty(cssBlock: string, name: string): string | undefined {
  const pattern = new RegExp(String.raw`--${name}\s*:\s*(#[0-9a-fA-F]{3,8})\s*;`);
  const match = pattern.exec(cssBlock);
  return match?.[1];
}

/**
 * Isolate the contents of a specific CSS selector's declaration block.
 * For ":root" or ".dark" style selectors.
 */
function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const pattern = new RegExp(String.raw`${escaped}\s*\{([\s\S]*?)\n\}`);
  const match = pattern.exec(css);
  if (!match?.[1]) {
    throw new Error(`CSS selector "${selector}" not found in ${CSS_PATH_FROM_REPO_ROOT}`);
  }
  return match[1];
}

/**
 * Parse one theme's colors from a CSS block.
 * Throws with a clear error listing any missing properties.
 */
function parseTheme(block: string, themeName: string): ThemeColors {
  const required = [
    ['brandRed', 'brand-red'],
    ['background', 'background'],
    ['backgroundPaper', 'background-paper'],
    ['foreground', 'foreground'],
    ['foregroundMuted', 'foreground-muted'],
    ['border', 'border'],
  ] as const;

  const result: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, cssName] of required) {
    const value = extractProperty(block, cssName);
    if (!value) {
      missing.push(`--${cssName}`);
    } else {
      result[key] = value;
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing CSS properties in ${themeName} theme: ${missing.join(', ')}. Check ${CSS_PATH_FROM_REPO_ROOT}`,
    );
  }

  return result as unknown as ThemeColors;
}

/**
 * Read brand colors from the shared Tailwind CSS file.
 * CSS is the single source of truth. Scripts parse it at generation time.
 */
export function getBrandColors(repoRoot?: string): BrandColors {
  const root = repoRoot ?? process.cwd();
  const css = readFileSync(path.join(root, CSS_PATH_FROM_REPO_ROOT), 'utf8');

  return {
    light: parseTheme(extractBlock(css, ':root'), 'light (:root)'),
    dark: parseTheme(extractBlock(css, '.dark'), 'dark (.dark)'),
  };
}
