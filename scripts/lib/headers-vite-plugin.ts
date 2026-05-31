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

export function parseHeadersFile(content: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  const lines = content.split('\n');
  let current: { pattern: string; headers: Record<string, string> } | null = null;

  function pushCurrent(): void {
    if (current) {
      rules.push({
        pattern: current.pattern,
        regex: patternToRegex(current.pattern),
        specificity: computeSpecificity(current.pattern),
        headers: current.headers,
      });
      current = null;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const rawLine = lines[i] ?? '';
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const isIndented = /^[ \t]/.test(line);

    if (isIndented) {
      if (!current) {
        throw new HeadersParseError(
          `Indented header line with no preceding path pattern: "${trimmed}"`,
          lineNumber
        );
      }
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx <= 0) {
        throw new HeadersParseError(`Malformed header line: "${trimmed}"`, lineNumber);
      }
      const name = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      if (name === '' || value === '') {
        throw new HeadersParseError(`Empty header name or value: "${trimmed}"`, lineNumber);
      }
      current.headers[name] = value;
    } else {
      pushCurrent();
      current = { pattern: trimmed, headers: {} };
    }
  }
  pushCurrent();
  return rules;
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
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
    .slice()
    .sort((a, b) => a.specificity - b.specificity);

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
