/**
 * Vite plugin that applies Cloudflare Pages `_headers` rules to preview
 * responses, so the production header stack — including the strict CSP with
 * extracted Astro hashes — is exercised by Playwright without spinning up
 * Miniflare.
 *
 * Dev mode is intentionally NOT supported. `astro dev` and `vite dev` serve
 * scripts from `src/` (with HMR transforms), so the hashes in the generated
 * `_headers` (computed from BUILT inline scripts) wouldn't match anything
 * served. Pretending to apply CSP in dev would produce noisy false-positive
 * violations on every page. The real CSP validation happens in `vite preview`
 * against the merged dist, which is what Playwright drives.
 *
 * Caller passes an absolute path to the `_headers` file. Missing file
 * throws — a broken build chain should fail the preview server start, not
 * silently pass e2e tests without CSP enforcement.
 *
 * Wired from:
 *   - `apps/web/vite.config.ts` (preview only)
 */
import { readFileSync, existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

export interface HeadersPluginOptions {
  /** Absolute path to the Cloudflare-style `_headers` file. */
  readonly headersFile: string;
}

export interface HeaderRule {
  readonly pattern: string;
  readonly regex: RegExp;
  readonly specificity: number;
  readonly headers: Record<string, string>;
}

export class HeadersParseError extends Error {
  constructor(
    message: string,
    public readonly line: number
  ) {
    super(`${message} (line ${String(line)})`);
    this.name = 'HeadersParseError';
  }
}

interface ParsedHeaderLine {
  readonly name: string;
  readonly value: string;
}

function parseHeaderLine(trimmed: string, lineNumber: number): ParsedHeaderLine {
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex <= 0) {
    throw new HeadersParseError(`Malformed header line: "${trimmed}"`, lineNumber);
  }
  const name = trimmed.slice(0, colonIndex).trim();
  const value = trimmed.slice(colonIndex + 1).trim();
  if (name === '' || value === '') {
    throw new HeadersParseError(`Empty header name or value: "${trimmed}"`, lineNumber);
  }
  return { name, value };
}

function finalizeRule(current: { pattern: string; headers: Record<string, string> }): HeaderRule {
  return {
    pattern: current.pattern,
    regex: patternToRegex(current.pattern),
    specificity: computeSpecificity(current.pattern),
    headers: current.headers,
  };
}

interface CurrentRule {
  pattern: string;
  headers: Record<string, string>;
}

interface ClassifiedLine {
  readonly kind: 'skip' | 'header' | 'pattern';
  readonly trimmed: string;
  readonly indented: boolean;
}

function classifyLine(rawLine: string): ClassifiedLine {
  const line = rawLine.replace(/\r$/, '');
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return { kind: 'skip', trimmed, indented: false };
  const indented = /^[ \t]/.test(line);
  return { kind: indented ? 'header' : 'pattern', trimmed, indented };
}

function applyHeaderToCurrent(
  current: CurrentRule | null,
  trimmed: string,
  lineNumber: number
): void {
  if (!current) {
    throw new HeadersParseError(
      `Indented header line with no preceding path pattern: "${trimmed}"`,
      lineNumber
    );
  }
  const { name, value } = parseHeaderLine(trimmed, lineNumber);
  current.headers[name] = value;
}

export function parseHeadersFile(content: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: CurrentRule | null = null;

  for (const [index, rawLine] of content.split('\n').entries()) {
    const lineNumber = index + 1;
    const classified = classifyLine(rawLine);
    if (classified.kind === 'skip') continue;
    if (classified.kind === 'header') {
      applyHeaderToCurrent(current, classified.trimmed, lineNumber);
    } else {
      if (current) rules.push(finalizeRule(current));
      current = { pattern: classified.trimmed, headers: {} };
    }
  }
  if (current) rules.push(finalizeRule(current));
  return rules;
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`).replaceAll('*', '.*');
  const withTrailingSlash = escaped.endsWith('/') ? escaped : `${escaped}/?`;
  return new RegExp(`^${withTrailingSlash}$`);
}

function computeSpecificity(pattern: string): number {
  return pattern.length - (pattern.match(/\*/g)?.length ?? 0);
}

export function matchHeaders(rules: readonly HeaderRule[], url: string): Record<string, string> {
  const pathname = (url.split('?')[0] ?? '').split('#')[0] ?? '';
  const matched = rules
    .filter((rule) => rule.regex.test(pathname))
    .toSorted((a, b) => a.specificity - b.specificity);

  const merged: Record<string, string> = {};
  for (const rule of matched) {
    for (const [name, value] of Object.entries(rule.headers)) {
      merged[name] = value;
    }
  }
  return merged;
}

export function applyHeaders(res: ServerResponse, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

function loadRules(headersFile: string): HeaderRule[] {
  if (!existsSync(headersFile)) {
    throw new Error(
      `[headers-vite-plugin] ${headersFile} not found. ` +
        `The preview server requires the generated _headers file. ` +
        `Run \`pnpm build && pnpm generate:headers\` first.`
    );
  }
  const content = readFileSync(headersFile, 'utf8');
  return parseHeadersFile(content);
}

export function headersPlugin(options: HeadersPluginOptions): Plugin {
  return {
    name: 'headers-vite-plugin',
    configurePreviewServer(server) {
      const rules = loadRules(options.headersFile);
      server.middlewares.use((req, res, next) => {
        if (req.url) {
          const matched = matchHeaders(rules, req.url);
          applyHeaders(res, matched);
        }
        next();
      });
    },
  };
}
