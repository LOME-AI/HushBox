import {
  ACCESSIBILITY_PREFERENCES_DEFAULTS,
  accessibilityPreferencesSchema,
} from '@hushbox/shared';
import type { AccessibilityPreferences } from '@hushbox/shared';

/** A settable accessibility preference — every key the persisted blob may carry. */
export type A11yField = keyof AccessibilityPreferences;

/** Any value any accessibility preference may hold. */
export type A11yFieldValue = AccessibilityPreferences[A11yField];

/**
 * One row of {@link A11Y_CLASS_RULES}, distributed over the field union so each
 * row's values are typed against its own field's enum: a renamed field, or a
 * value outside that field's enum, matches no member and fails at typecheck.
 *
 * `except` names the complement inside the field's own enum instead of listing
 * the members, so a value added to the schema joins the set with no second edit.
 */
type RuleFor<F extends A11yField> = F extends unknown
  ?
      | Readonly<{ className: string; field: F; when: readonly AccessibilityPreferences[F][] }>
      | Readonly<{ className: string; field: F; except: AccessibilityPreferences[F] }>
  : never;

export type A11yClassRule = RuleFor<A11yField>;

/**
 * The class the custom-font stack keys off. Named because the pre-paint script
 * sets `--a11y-font-family` exactly when this class is on, and the font loader
 * writes the same pair after mount.
 */
export const A11Y_FONT_OVERRIDE_CLASS = 'a11y-font-override';

/**
 * Every `<html>` class an accessibility preference controls: present iff that
 * field's value is in the row's set. Single source of truth — the post-mount
 * applier reads it directly and the pre-paint script is generated from it, so a
 * row added here reaches both with no second edit.
 *
 * Two classes are deliberately outside it because no single preference decides
 * them: `reduced-motion` merges a media query and a host override alongside
 * `stopAnimations`, and the colorblind filters are markup rather than a class.
 */
export const A11Y_CLASS_RULES = [
  { className: 'a11y-contrast-increased', field: 'contrast', when: ['increased'] },
  { className: 'a11y-contrast-high', field: 'contrast', when: ['high'] },
  { className: 'a11y-contrast-low', field: 'contrast', when: ['low'] },

  { className: 'a11y-saturate-0', field: 'saturation', when: ['0'] },
  { className: 'a11y-saturate-50', field: 'saturation', when: ['50'] },
  { className: 'a11y-saturate-150', field: 'saturation', when: ['150'] },

  { className: 'a11y-cb-protan', field: 'colorblindSimulate', when: ['protan'] },
  { className: 'a11y-cb-deutan', field: 'colorblindSimulate', when: ['deutan'] },
  { className: 'a11y-cb-tritan', field: 'colorblindSimulate', when: ['tritan'] },
  { className: 'a11y-cb-achroma', field: 'colorblindSimulate', when: ['achroma'] },
  { className: 'a11y-cb-achromatomaly', field: 'colorblindSimulate', when: ['achromatomaly'] },

  { className: 'a11y-font-scale-88', field: 'fontSize', when: ['88'] },
  { className: 'a11y-font-scale-112', field: 'fontSize', when: ['112'] },
  { className: 'a11y-font-scale-124', field: 'fontSize', when: ['124'] },
  { className: 'a11y-font-scale-141', field: 'fontSize', when: ['141'] },

  { className: 'a11y-letter-spacing-loose', field: 'letterSpacing', when: ['0.05'] },
  { className: 'a11y-letter-spacing-loosest', field: 'letterSpacing', when: ['0.12'] },

  // '1.5' is Normal — no class, so each text style keeps its own line height.
  { className: 'a11y-line-height-tight', field: 'lineHeight', when: ['1.0'] },
  { className: 'a11y-line-height-double', field: 'lineHeight', when: ['2.0'] },

  { className: 'a11y-para-spacing-double', field: 'paragraphSpacing', when: ['2'] },

  { className: A11Y_FONT_OVERRIDE_CLASS, field: 'fontFamily', except: 'system' },

  { className: 'a11y-cursor-large', field: 'cursorSize', when: ['large'] },
  { className: 'a11y-cursor-xlarge', field: 'cursorSize', when: ['xlarge'] },

  { className: 'a11y-cursor-white', field: 'cursorColor', when: ['white'] },

  // '0' is "no custom focus ring" — leave the browser's own alone.
  { className: 'a11y-focus-strong', field: 'focusWidth', except: '0' },
  { className: 'a11y-focus-halo', field: 'focusHalo', when: [true] },
] as const satisfies readonly A11yClassRule[];

/**
 * The values a field may hold and the value it falls back to, read from the
 * schema itself so neither consumer can carry a stale copy.
 */
export function fieldDomain(field: A11yField): {
  readonly allowed: readonly A11yFieldValue[];
  readonly fallback: A11yFieldValue;
} {
  return {
    allowed: allowedValues(field),
    fallback: ACCESSIBILITY_PREFERENCES_DEFAULTS[field],
  };
}

/** The values that put a rule's class on the root. */
export function ruleValues(rule: A11yClassRule): readonly A11yFieldValue[] {
  if ('when' in rule) return rule.when;
  return allowedValues(rule.field).filter((value) => value !== rule.except);
}

/**
 * Structural stand-in for zod's boolean schema. It is the refusal point for a
 * field shape neither evaluator can express: set membership is the only
 * predicate they have, so a field that is not an enum has to be a boolean, and
 * a schema of any other type fails to match this parameter at typecheck.
 */
export interface BooleanSchema {
  readonly def: { readonly type: 'boolean' };
}

function bothBooleans(_schema: BooleanSchema): readonly A11yFieldValue[] {
  return [true, false];
}

/**
 * Throws for a field carrying no default, which has nothing to resolve an
 * unstored value to. A field whose schema is neither an enum nor a boolean is
 * refused one step earlier, by {@link BooleanSchema} at typecheck.
 */
function allowedValues(field: A11yField): readonly A11yFieldValue[] {
  const { def } = accessibilityPreferencesSchema.shape[field];
  if (!('innerType' in def)) {
    throw new Error(`Accessibility field "${field}" declares no default to fall back to`);
  }
  const inner = def.innerType;
  return 'options' in inner ? inner.options : bothBooleans(inner);
}
