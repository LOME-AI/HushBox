import { createCssVariablesTheme, createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import css from 'shiki/langs/css.mjs';
import html from 'shiki/langs/html.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import python from 'shiki/langs/python.mjs';
import shellscript from 'shiki/langs/shellscript.mjs';
import sql from 'shiki/langs/sql.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import { CODE_TOKEN_KINDS } from './code-block';
import type { CodeToken, CodeTokenKind } from './code-block';
import type { HighlighterCore } from 'shiki/core';

/**
 * Which file extension reads as which grammar. The languages loaded below are
 * exactly the values here: an extension outside this map has no language, and
 * its source renders unhighlighted rather than guessed at.
 */
const LANGUAGE_BY_EXTENSION = {
  cjs: 'javascript',
  css: 'css',
  cts: 'typescript',
  html: 'html',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  py: 'python',
  sh: 'shellscript',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'tsx',
  yaml: 'yaml',
  yml: 'yaml',
} as const;

type CodeLanguage = (typeof LANGUAGE_BY_EXTENSION)[keyof typeof LANGUAGE_BY_EXTENSION];

export { CODE_TOKEN_KINDS } from './code-block';
export type { CodeToken } from './code-block';

function isLanguageExtension(extension: string): extension is keyof typeof LANGUAGE_BY_EXTENSION {
  return Object.hasOwn(LANGUAGE_BY_EXTENSION, extension);
}

/** The grammar a repo-relative path reads as, or `null` when nothing here fits it. */
export function languageForPath(path: string): CodeLanguage | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return isLanguageExtension(extension) ? LANGUAGE_BY_EXTENSION[extension] : null;
}

/**
 * The theme is a scope classifier, not a palette: it collapses a grammar's
 * TextMate scopes onto the dozen kinds `CODE_TOKEN_KINDS` names, handing each
 * back as `var(--code-token-<kind>)`. `highlightLines` parses that straight
 * back into the kind, and the code block paints the kind with its Tailwind theme
 * token; a consumer that renders Shiki's own output binds each variable instead.
 */
const CLASSIFIER_NAME = 'code-token-kinds';
const CLASSIFIER = createCssVariablesTheme({
  name: CLASSIFIER_NAME,
  variablePrefix: '--code-',
});
const CLASSIFIED_KIND = /^var\(--code-token-([a-z-]+)\)$/;

export { CLASSIFIER as CODE_TOKEN_THEME };

let shared: HighlighterCore | null = null;

/**
 * Synchronous by construction: the JavaScript regex engine needs no WebAssembly
 * to load, so a peek that opens on hover paints its code already colored and
 * never has a resolving state to show. Building it is deferred to the first
 * highlighted line so nothing pays for grammars it does not use.
 */
function highlighter(): HighlighterCore {
  shared ??= createHighlighterCoreSync({
    themes: [CLASSIFIER],
    langs: [
      css,
      html,
      javascript,
      json,
      jsx,
      markdown,
      python,
      shellscript,
      sql,
      tsx,
      typescript,
      yaml,
    ],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return shared;
}

/**
 * A themed tokenization colors every token, so an uncolored one is not a state
 * worth handling: anything that is not one of the classifier's variables — the
 * theme's own foreground included — is simply no kind.
 */
function kindOf(color: string | undefined): CodeTokenKind | null {
  const classified = CLASSIFIED_KIND.exec(String(color))?.[1];
  return CODE_TOKEN_KINDS.find((kind) => kind === classified) ?? null;
}

/** One row of tokens per line given, in the order the lines were given. */
export function highlightLines(
  lines: readonly string[],
  language: CodeLanguage
): readonly (readonly CodeToken[])[] {
  const { tokens } = highlighter().codeToTokens(lines.join('\n'), {
    lang: language,
    theme: CLASSIFIER_NAME,
  });
  return tokens.map((row) =>
    row.map((token) => ({ text: token.content, kind: kindOf(token.color) }))
  );
}
