import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const motionCss = readFileSync(path.join(stylesDir, 'motion.css'), 'utf8');

/**
 * The theme reveal animates `::view-transition-new(root)`, a pseudo-element on a
 * tree rooted at the document element, so `html.reduced-motion *` and its
 * `::before`/`::after` companions match none of it.
 *
 * This is a source assertion and is weaker than the rest of the styles suite on
 * purpose: the pseudo tree exists only while a real engine runs a transition,
 * and the test DOM's CSS parser discards the rule outright rather than exposing
 * it through CSSOM. The behavioural guarantee is carried by the JS guard in
 * `lib/trigger-view-transition.ts`, which is tested against real calls; this
 * rule is the backstop for an engine that starts a transition anyway.
 *
 * `!important` is matched, not incidental: the rule it overrides
 * (`::view-transition-new(root)` in packages/config/tailwind/index.css) is
 * unlayered, and an unlayered normal declaration outranks a layered one whatever
 * its specificity. Without `!important` this rule parses, matches, and loses.
 */
describe('reduced-motion suppression of the theme reveal', () => {
  it('cancels the animation on the view-transition pseudo-element the blanket rule cannot reach', () => {
    expect(motionCss).toMatch(
      /html\.reduced-motion::view-transition-new\(root\)\s*{\s*animation:\s*none\s*!important/
    );
  });
});
