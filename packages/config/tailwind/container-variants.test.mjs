// @ts-check
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

/**
 * A component that switches on its own width writes `@max-<key>/<name>:` or
 * `@min-<key>/<name>:`, and Tailwind builds that variant from the `--container-<key>`
 * theme value the generated token block declares. This proves the build against the
 * block as committed, so a key the block stops declaring fails here rather than
 * silently compiling to nothing in a component.
 */

const STYLESHEET = path.join(import.meta.dirname, 'index.css');
const BEGIN = '/* BEGIN GENERATED: design-tokens */';
const END = '/* END GENERATED: design-tokens */';

/**
 * The generated token block, markers excluded.
 * @returns {string}
 */
function tokenBlock() {
  const css = readFileSync(STYLESHEET, 'utf8');
  const start = css.indexOf(BEGIN);
  const end = css.indexOf(END, start);
  if (start === -1 || end === -1) throw new Error(`${STYLESHEET} has no token block markers`);
  return css.slice(start + BEGIN.length, end);
}

/**
 * The CSS Tailwind emits for `candidates` against `block`.
 * @param {string} block
 * @param {readonly string[]} candidates
 * @returns {Promise<string>}
 */
async function emitted(block, candidates) {
  const compiler = await compile(`${block}\n@tailwind utilities;\n`, {
    base: import.meta.dirname,
  });
  return compiler.build([...candidates]);
}

const CANDIDATE = '@max-composer-compact/composer:hidden';
const CONDITION = '@container composer (width < 34rem)';
const KEY_DECLARATION = /^\s*--container-composer-compact:[^;]*;\n/m;

describe('the container keys in the token block', () => {
  it('compile a named max-width container variant from a theme key', async () => {
    expect(await emitted(tokenBlock(), [CANDIDATE])).toContain(CONDITION);
  });

  it('compile no such variant once the key is taken out of the block', async () => {
    const block = tokenBlock();
    const withoutKey = block.replace(KEY_DECLARATION, '');
    expect(withoutKey).not.toBe(block);
    expect(await emitted(withoutKey, [CANDIDATE])).not.toContain(CONDITION);
  });
});
