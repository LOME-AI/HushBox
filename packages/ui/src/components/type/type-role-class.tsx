import { TYPE_ROLES, type TypeRole } from '@hushbox/shared/design-tokens';

/**
 * Each role's generated utility, which carries its size, line height, weight and
 * tracking, plus tabular figures for the two figure roles. Written whole in this `.tsx`
 * file because the shared stylesheet's class scan of `packages/ui` reads `.tsx` files
 * only and emits only the classes it finds spelled out.
 */
const ROLE_CLASS: Readonly<Record<TypeRole, string>> = {
  'display-1': 'text-display-1',
  'display-2': 'text-display-2',
  'title-1': 'text-title-1',
  'title-2': 'text-title-2',
  'title-3': 'text-title-3',
  'title-3-read': 'text-title-3-read',
  lead: 'text-lead',
  body: 'text-body',
  'body-lg': 'text-body-lg',
  'body-sub': 'text-body-sub',
  'ui-lg': 'text-ui-lg',
  ui: 'text-ui',
  'ui-sm': 'text-ui-sm',
  caption: 'text-caption',
  mono: 'text-mono',
  num: 'text-num tabular-nums',
  tabular: 'text-tabular tabular-nums',
  'site-hero': 'text-site-hero',
  'site-section': 'text-site-section',
  'site-title': 'text-site-title',
  'auth-title': 'text-auth-title',
  'header-title': 'text-header-title',
  'chat-greeting': 'text-chat-greeting',
  'site-post-title': 'text-site-post-title',
  'site-lead': 'text-site-lead',
  'site-value': 'text-site-value',
  'site-subhead': 'text-site-subhead',
  'site-trust': 'text-site-trust',
  'ui-snug': 'text-ui-snug',
  'site-card-title': 'text-site-card-title',
  'mono-sm': 'text-mono-sm',
  'site-cipher': 'text-site-cipher',
};

const FACE_CLASS = {
  serif: 'font-serif',
  sans: 'font-sans',
  mono: 'font-mono',
} as const satisfies Record<(typeof TYPE_ROLES)[TypeRole]['face'], string>;

/** The classes that set the `variant` type role's face, size, line height and weight. */
export function typeRoleClass(variant: TypeRole): string {
  return `${ROLE_CLASS[variant]} ${FACE_CLASS[TYPE_ROLES[variant].face]}`;
}
