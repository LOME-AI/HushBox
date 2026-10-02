import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as lucideStatic from 'lucide-static';
import {
  SHIPPED_FEATURES,
  COMING_SOON_FEATURES,
} from '../../packages/shared/src/platform/features.js';
import { withCache } from './cache.js';
import { collectModuleClosure } from './module-closure.js';
import { isMainModule } from '../lib/cli/is-main.js';
import { readCommandLineOrRefuse, type CommandSpec } from '../lib/cli/command-line.js';

const LIGHT_STROKE = '#1f2328';
const DARK_STROKE = '#e6edf3';

/**
 * Convert a PascalCase Lucide icon name to kebab-case filename.
 * e.g. "MessagesSquare" → "messages-square"
 */
export function toKebabCase(name: string): string {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Transform a lucide-static SVG string into a theme-aware version
 * that works when referenced via <img> (where currentColor has no context).
 */
export function makeThemeAware(svg: string): string {
  const styleBlock = `<style>*{stroke:${LIGHT_STROKE}}@media(prefers-color-scheme:dark){*{stroke:${DARK_STROKE}}}</style>`;

  return svg
    .replace(/\s*class="[^"]*"/, '')
    .replaceAll('stroke="currentColor"', '')
    .replaceAll('fill="currentColor"', `fill="${LIGHT_STROKE}"`)
    .replace(/<svg([^>]*)>/, `<svg$1>${styleBlock}`);
}

/**
 * Resolve a Lucide icon name to its SVG string from lucide-static.
 */
export function getIconSvg(name: string): string {
  const svg = (lucideStatic as Record<string, string>)[name];
  if (!svg) {
    throw new Error(`Lucide icon "${name}" not found in lucide-static`);
  }
  return svg;
}

/**
 * Files whose contents determine the icon output. A change to any of these
 * invalidates the cache and forces regeneration.
 */
export function collectIconInputs(repoRoot: string): string[] {
  return [
    ...collectModuleClosure([path.join(repoRoot, 'scripts/readme/generate-icons.ts')]),
    // Third-party SVG bodies are pinned by their manifest's version rather than
    // hashed. Resolved, not joined: the dependency is declared per workspace, so
    // pnpm's install layout — not the repo root — decides where it lands.
    createRequire(import.meta.url).resolve('lucide-static/package.json'),
  ];
}

/**
 * Generate all icon SVG files into the target directory.
 * Returns the list of filenames (whether freshly generated or already cached).
 */
export function generateIcons(outputDir: string, repoRoot?: string): string[] {
  const root = repoRoot ?? process.cwd();
  const allFeatures = [
    ...SHIPPED_FEATURES.map((f) => ({ id: f.id, lucideIcon: f.lucideIcon })),
    ...COMING_SOON_FEATURES.map((f) => ({ id: f.id, lucideIcon: f.lucideIcon })),
  ];
  const filenames = allFeatures.map((f) => `${toKebabCase(f.lucideIcon)}.svg`);
  const outputs = filenames.map((f) => path.join(outputDir, f));

  withCache(
    {
      label: 'Icons',
      hashPath: path.join(root, '.github/readme/.cache/icons.hash'),
      inputs: collectIconInputs(root),
      outputs,
    },
    () => {
      mkdirSync(outputDir, { recursive: true });
      for (const feature of allFeatures) {
        const raw = getIconSvg(feature.lucideIcon);
        const themed = makeThemeAware(raw);
        const filePath = path.join(outputDir, `${toKebabCase(feature.lucideIcon)}.svg`);
        writeFileSync(filePath, themed);
      }
      console.log(`✓ Generated ${String(filenames.length)} icon SVGs in ${outputDir}`);
    }
  );

  return filenames;
}

const DEFAULT_OUTPUT = path.resolve(import.meta.dirname, '../../packages/ui/src/assets/icons');

export const COMMAND_LINE = {
  command: 'pnpm generate:icons',
  summary: 'Renders the README icon set.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI wiring; the generator is covered via unit tests */
const isMain = isMainModule(import.meta.url);
if (isMain && readCommandLineOrRefuse(COMMAND_LINE, process.argv.slice(2)) !== null)
  generateIcons(DEFAULT_OUTPUT);
/* v8 ignore stop */
