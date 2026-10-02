/**
 * Reads custom properties out of stylesheet SOURCE. The accessibility tokens
 * these tests are about are declared in `.css` files and in the tailwind config,
 * neither of which any test here renders, so the source text is the only place
 * their declared values can be observed.
 */

/**
 * One selector's block, delimited by balancing braces rather than by reading to
 * the first `}`. The theme's `.dark` block nests rulesets, so a non-balancing
 * reader stops early and reports a declared token as missing.
 */
function selectorBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector ${selector} not found`);
  let depth = 0;
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, index);
    }
  }
  throw new Error(`selector ${selector} is unterminated`);
}

/**
 * A custom property declared directly in `selector`, or null when it only
 * inherits one. A tier override carries `!important`; the marker is not part of
 * the value and is not returned.
 */
export function declaredValue(css: string, selector: string, variable: string): string | null {
  const match = new RegExp(String.raw`${variable}:\s*([^;!]+)`).exec(selectorBlock(css, selector));
  const value = match?.[1];
  return value === undefined ? null : value.trim();
}
