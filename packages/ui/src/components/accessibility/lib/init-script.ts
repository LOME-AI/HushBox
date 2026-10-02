import { scriptSafeJson } from '@hushbox/shared/script-safe-json';
import { A11Y_STORAGE_KEY } from '@hushbox/shared';
import {
  A11Y_CLASS_RULES,
  A11Y_FONT_OVERRIDE_CLASS,
  fieldDomain,
  ruleValues,
} from './class-toggles.ts';
import { REDUCED_MOTION_CLASS } from './reduced-motion-class.ts';
import type { A11yField, A11yFieldValue } from './class-toggles.ts';

/**
 * Preferences the scaffold below reads by name without a class rule pointing at
 * them, so they have to be resolved too. Typed against the schema, so renaming
 * one of them is a compile error rather than an `undefined` at first paint.
 */
const SCAFFOLD_FIELDS = [
  'stopAnimations',
  'focusWidth',
  'focusColor',
  'fontFamily',
] as const satisfies readonly A11yField[];

/** Every field the script resolves, paired with its allowed values and its fallback. */
function resolvableFields(): Record<
  string,
  { readonly a: readonly A11yFieldValue[]; readonly d: A11yFieldValue }
> {
  const fields = new Set<A11yField>([
    ...A11Y_CLASS_RULES.map((rule) => rule.field),
    ...SCAFFOLD_FIELDS,
  ]);
  const domains: Record<string, { a: readonly A11yFieldValue[]; d: A11yFieldValue }> = {};
  for (const field of fields) {
    const { allowed, fallback } = fieldDomain(field);
    domains[field] = { a: allowed, d: fallback };
  }
  return domains;
}

/** Each class rule flattened to the triple the script's loop reads. */
function flattenedRules(): readonly (readonly [string, A11yField, readonly A11yFieldValue[]])[] {
  return A11Y_CLASS_RULES.map((rule) => [rule.className, rule.field, ruleValues(rule)] as const);
}

/**
 * Refuse a body that would break out of the `<script>` element it is inlined
 * into, or that carries a line separator an older parser treats as a newline.
 * Both are fatal at generation time rather than silently shipped, because the
 * script's own `try`/`catch` degrades without a trace in a browser.
 */
export function assertInlineSafe(body: string): string {
  for (const hazard of ['</script', '\u2028', '\u2029']) {
    if (body.includes(hazard)) {
      throw new Error('The accessibility init script contains a sequence unsafe to inline');
    }
  }
  return body;
}

/**
 * Inline `<head>` accessibility-bootstrap script, generated from the shared
 * class-toggle table so what it puts on `<html>` before first paint is what
 * `applySettings` puts there after mount — a row added to the table reaches both
 * with no edit here.
 *
 * It resolves every field it reads against that field's own allowed values,
 * falling back to the schema default, which is the same reconciliation the store
 * performs on load. That is why it runs even with nothing stored: the defaults
 * are not all inert, so returning early would leave a class for the applier to
 * add after paint, which is the flash this script exists to prevent.
 *
 * The evaluator below is written a second time in ES5 because an inline script
 * cannot import TypeScript. Only the evaluation is repeated — every class name,
 * value set, default and key is interpolated from the shared data, so the two
 * cannot disagree about *what* to apply. `growth/init-script.ts` carries the
 * same residual for the same reason.
 *
 * Constraints:
 *  - Must be a self-contained ES5 string (no imports, nothing a legacy parser trips on).
 *  - Must never throw.
 */
export const A11Y_INIT_SCRIPT: string = assertInlineSafe(`
(function () {
  try {
    var html = document.documentElement;
    var DOMAINS = ${scriptSafeJson(resolvableFields())};
    var RULES = ${scriptSafeJson(flattenedRules())};

    var osReducedMotion = false;
    try {
      osReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {}

    var raw = null;
    try { raw = window.localStorage.getItem(${scriptSafeJson(A11Y_STORAGE_KEY)}); } catch (e) { raw = null; }

    var stored = {};
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed.state === 'object' && parsed.state !== null) stored = parsed.state;
      } catch (e) {}
    }

    var resolved = {}, field, domain;
    for (field in DOMAINS) {
      domain = DOMAINS[field];
      resolved[field] = domain.a.indexOf(stored[field]) >= 0 ? stored[field] : domain.d;
    }

    var i, rule;
    for (i = 0; i < RULES.length; i++) {
      rule = RULES[i];
      if (rule[2].indexOf(resolved[rule[1]]) >= 0) html.classList.add(rule[0]);
    }

    if (osReducedMotion || resolved.stopAnimations === true) {
      html.classList.add(${scriptSafeJson(REDUCED_MOTION_CLASS)});
    }

    html.style.setProperty('--a11y-focus-width', resolved.focusWidth + 'px');
    html.style.setProperty('--a11y-focus-color', resolved.focusColor);

    // The @font-face rules live in the bundled accessibility CSS, emitted from a
    // single canonical woff2 source by each app's bundler. Pre-paint we only set
    // --a11y-font-family so typography.css's font-family: var(--a11y-font-family)
    // resolves the chosen family before first paint; the font file's own fetch is
    // deliberately not warmed by an inline link rel=preload.
    if (html.classList.contains(${scriptSafeJson(A11Y_FONT_OVERRIDE_CLASS)})) {
      html.style.setProperty('--a11y-font-family', '"' + resolved.fontFamily + '"');
    }
  } catch (e) {
  }
})();
`);
