/**
 * Renders `@hushbox/shared/design-tokens` into the marked block of the shared
 * stylesheet every frontend imports. The module is the source; the block is its
 * render, kept in the stylesheet because tests and scripts across the repository
 * parse that file's text for token values. This script's own test refuses a
 * committed block that differs from the render, and the pre-commit hook stages a
 * fresh one.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as DESIGN_TOKENS from '@hushbox/shared/design-tokens';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';

/** The stylesheet holding the block, relative to the repository root. */
export const STYLESHEET = 'packages/config/tailwind/index.css';

const MARKER = 'design-tokens';
const BEGIN = `/* BEGIN GENERATED: ${MARKER} */\n`;
const END = `/* END GENERATED: ${MARKER} */`;

/**
 * A media query's rem resolves against the initial font size, never the document
 * root, so the band's pixel width divides by this to match Tailwind's `md:`.
 */
const MEDIA_QUERY_REM_BASE_PX = 16;

interface TypeRoleSource {
  readonly size: string;
  readonly lineHeight: string;
  readonly weight: number;
  readonly tracking?: string;
  readonly fromDesktop?: { readonly size: string; readonly lineHeight: string };
}

/**
 * What the render reads from the token module. Keyed by plain strings rather than the
 * module's own unions, so a test can render a source smaller than the real one.
 */
export interface TokenSource {
  readonly THEME_COLOURS: Readonly<Record<'light' | 'dark', Readonly<Record<string, string>>>>;
  readonly THEME_ALIASES: Readonly<Record<string, string>>;
  readonly FONT_FAMILIES: Readonly<Record<string, string>>;
  readonly RADIUS: { readonly base: string; readonly steps: Readonly<Record<string, string>> };
  readonly APP_HEADER_HEIGHT: string;
  readonly MOTION: {
    readonly fastMs: number;
    readonly baseMs: number;
    readonly slowMs: number;
    readonly deliberateMs: number;
  };
  readonly Z: Readonly<Record<string, number>>;
  readonly TYPE_ROLES: Readonly<Record<string, TypeRoleSource>>;
  readonly LAYOUT: {
    readonly bandPx: number;
    readonly buttonRule: {
      readonly fullWidthMax: string;
      readonly minWidth: string;
      readonly stackTwoBelow: string;
      readonly stackManyBelow: string;
    };
    readonly containers: Readonly<Record<string, string>>;
  };
}

type Declarations = readonly (readonly [string, string])[];

/** One rule's body, at `depth` levels of two-space indentation. */
function body(declarations: Declarations, depth: number): string {
  const indent = '  '.repeat(depth);
  return declarations.map(([name, value]) => `${indent}${name}: ${value};\n`).join('');
}

/** Groups of declarations inside one rule, a blank line between groups. */
function rule(selector: string, groups: readonly Declarations[]): string {
  const bodies = groups.filter((group) => group.length > 0).map((group) => body(group, 1));
  return `${selector} {\n${bodies.join('\n')}}\n`;
}

function typeRoleDeclarations(roles: TokenSource['TYPE_ROLES']): Declarations {
  return Object.entries(roles).flatMap(([role, values]) => {
    const key = `--text-${role}`;
    const declarations: [string, string][] = [
      [key, values.size],
      [`${key}--line-height`, values.lineHeight],
      [`${key}--font-weight`, String(values.weight)],
    ];
    if (values.tracking !== undefined) {
      declarations.push([`${key}--letter-spacing`, values.tracking]);
    }
    return declarations;
  });
}

/** The roles that step up at the band, as `:root` overrides of their theme keys. */
function desktopOverride(tokens: TokenSource): string {
  const declarations = Object.entries(tokens.TYPE_ROLES).flatMap(([role, values]) =>
    values.fromDesktop === undefined
      ? []
      : [
          [`--text-${role}`, values.fromDesktop.size] as const,
          [`--text-${role}--line-height`, values.fromDesktop.lineHeight] as const,
        ]
  );
  if (declarations.length === 0) return '';
  const band = `${String(tokens.LAYOUT.bandPx / MEDIA_QUERY_REM_BASE_PX)}rem`;
  return `\n@media (width >= ${band}) {\n  :root {\n${body(declarations, 2)}  }\n}\n`;
}

function zUtilities(z: TokenSource['Z']): string {
  return Object.entries(z)
    .map(([name, index]) => `\n@utility z-${name} {\n  z-index: ${String(index)};\n}\n`)
    .join('');
}

/** The text that sits between the markers, for `tokens`. */
export function renderTokenBlock(tokens: TokenSource): string {
  const { THEME_COLOURS, LAYOUT, MOTION } = tokens;
  const header =
    '/* Generated from packages/shared/src/design/tokens.ts by `pnpm generate:design-tokens`.\n' +
    '   Edit that module and regenerate; a hand edit here fails the token freshness test. */\n';
  const root = rule(':root', [
    [
      ...Object.entries(THEME_COLOURS.light),
      ['--radius', tokens.RADIUS.base],
      ['--app-header-height', tokens.APP_HEADER_HEIGHT],
    ],
  ]);
  const dark = rule('.dark', [Object.entries(THEME_COLOURS.dark)]);
  const mapping = rule('@theme inline', [
    Object.entries(tokens.FONT_FAMILIES).map(([face, stack]) => [`--font-${face}`, stack]),
    Object.keys(THEME_COLOURS.light).map((token) => [`--color-${token.slice(2)}`, `var(${token})`]),
    Object.entries(tokens.THEME_ALIASES).map(([alias, value]) => [`--color-${alias}`, value]),
    Object.entries(tokens.RADIUS.steps).map(([step, value]) => [`--radius-${step}`, value]),
  ]);
  const scales = rule('@theme', [
    [
      ['--motion-fast', `${String(MOTION.fastMs)}ms`],
      ['--motion-base', `${String(MOTION.baseMs)}ms`],
      ['--motion-slow', `${String(MOTION.slowMs)}ms`],
      ['--motion-deliberate', `${String(MOTION.deliberateMs)}ms`],
    ],
    [
      ['--btn-full-max', LAYOUT.buttonRule.fullWidthMax],
      ['--btn-min', LAYOUT.buttonRule.minWidth],
      ['--btn-stack-two', LAYOUT.buttonRule.stackTwoBelow],
      ['--btn-stack-many', LAYOUT.buttonRule.stackManyBelow],
    ],
    typeRoleDeclarations(tokens.TYPE_ROLES),
    Object.entries(LAYOUT.containers).map(([key, width]) => [`--container-${key}`, width]),
  ]);
  return (
    `${header}${root}\n${dark}\n${mapping}\n${scales}` +
    `${desktopOverride(tokens)}${zUtilities(tokens.Z)}`
  );
}

/** `stylesheet` with the text between its markers replaced by `block`. */
export function replaceTokenBlock(stylesheet: string, block: string): string {
  const start = stylesheet.indexOf(BEGIN);
  const end = stylesheet.indexOf(END, start);
  if (start === -1 || end === -1) {
    throw new Error(
      `${STYLESHEET} has no \`${BEGIN.trim()}\` … \`${END}\` pair to write the token block into`
    );
  }
  return `${stylesheet.slice(0, start + BEGIN.length)}${block}${stylesheet.slice(end)}`;
}

/** Whether `stylesheet` already carries the render of `tokens` between its markers. */
export function blockIsCurrent(stylesheet: string, tokens: TokenSource): boolean {
  return replaceTokenBlock(stylesheet, renderTokenBlock(tokens)) === stylesheet;
}

/** Rewrites the block under `repoRoot` when it is stale; true when it wrote. */
export function generateDesignTokens(options: {
  readonly repoRoot: string;
  readonly tokens: TokenSource;
}): boolean {
  const file = path.join(options.repoRoot, STYLESHEET);
  const current = readFileSync(file, 'utf8');
  const next = replaceTokenBlock(current, renderTokenBlock(options.tokens));
  if (next === current) return false;
  writeFileSync(file, next);
  return true;
}

export const COMMAND_LINE = {
  command: 'pnpm generate:design-tokens',
  summary: `Renders @hushbox/shared/design-tokens into the marked block of ${STYLESHEET}.`,
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point exercised via shell */
if (isMainModule(import.meta.url)) {
  await runMain(() => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const wrote = generateDesignTokens({ repoRoot, tokens: DESIGN_TOKENS });
    console.error(wrote ? `Wrote ${STYLESHEET}` : `Unchanged ${STYLESHEET}`);
  });
}
/* v8 ignore stop */
