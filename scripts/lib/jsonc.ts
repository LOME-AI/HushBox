import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Where a string literal opened at `start` ends, one past its closing quote.
 * A backslash consumes the character after it, so an escaped quote does not
 * close the string. An unterminated literal runs to the end of input, leaving
 * `JSON.parse` to reject it.
 */
function stringEnd(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === '\\') {
      index += 2;
      continue;
    }
    index += 1;
    if (char === '"') return index;
  }
  return index;
}

/** Where the line comment at `start` ends: at its newline, or at end of input. */
function lineCommentEnd(source: string, start: number): number {
  const lineBreak = source.indexOf('\n', start);
  return lineBreak === -1 ? source.length : lineBreak;
}

/** Where the block comment at `start` ends: past its closer, or at end of input. */
function blockCommentEnd(source: string, start: number): number {
  const close = source.indexOf('*/', start + 2);
  return close === -1 ? source.length : close + 2;
}

/** What the construct at `index` contributes to the JSON, and where it ends. */
function step(source: string, index: number): { readonly emit: string; readonly next: number } {
  const char = source.charAt(index);
  const pair = source.slice(index, index + 2);
  if (char === '"') {
    const end = stringEnd(source, index);
    return { emit: source.slice(index, end), next: end };
  }
  if (pair === '//') return { emit: '', next: lineCommentEnd(source, index) };
  if (pair === '/*') return { emit: '', next: blockCommentEnd(source, index) };
  return { emit: char, next: index + 1 };
}

/** The text with a comma dropped when nothing but whitespace follows it. */
function dropTrailingComma(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.endsWith(',') ? trimmed.slice(0, -1) : text;
}

/**
 * JSONC reduced to the JSON it means: comments removed, trailing commas
 * dropped. It scans characters rather than filtering lines because every config
 * read through here carries a `$schema` URL whose `//` must survive — string
 * state is the only thing that tells that `//` from a comment's, and a line
 * filter buys that immunity by being blind to a comment after content.
 */
function toJson(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const { emit, next } = step(source, index);
    out = emit === '}' || emit === ']' ? dropTrailingComma(out) : out;
    out += emit;
    index = next;
  }
  return out;
}

/** Parse JSONC source. */
export function parseJsonc(source: string): unknown {
  return JSON.parse(toJson(source));
}

/** Parse a JSONC config named by its repo-relative path. */
export function readJsonc(file: string): unknown {
  return parseJsonc(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
}
