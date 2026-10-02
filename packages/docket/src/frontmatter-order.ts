/**
 * The order a finding's frontmatter keys are emitted in. Fixed, so a write
 * changes nothing but the bytes it means to: a re-emitted finding is
 * byte-identical to what it replaced.
 *
 * It lives in its own module so the emitter's dependence on it is the only way
 * the order can be set, provable by substitution rather than asserted.
 */
export const FRONTMATTER_KEY_ORDER = [
  'id',
  'title',
  'severity',
  'kind',
  'status',
  'status_note',
  'area',
  'needs_ruling',
  'needs_options',
  'warning',
  'related',
  'group',
  'dedicated',
  'state',
  'ruling',
  'denial',
  'history',
  'questions',
  'progress',
] as const;

export type FrontmatterKey = (typeof FRONTMATTER_KEY_ORDER)[number];
