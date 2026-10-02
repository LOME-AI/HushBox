import { TYPE_ROLES, type TypeRole } from '@hushbox/shared/design-tokens';
import { typeRoleClass } from './type-role-class';
import type * as React from 'react';

type TextTone = 'default' | 'muted' | 'signal' | 'error' | 'success' | 'warning';

/** The default tone sets no colour, so the text takes the ink of what surrounds it. */
const TONE_CLASS: Readonly<Record<TextTone, string>> = {
  default: '',
  muted: ' text-muted-foreground',
  signal: ' text-brand-red',
  error: ' text-error',
  success: ' text-success',
  warning: ' text-warning',
};

interface TextProps {
  variant: TypeRole;
  /** Omitted, a type role that is muted by definition draws muted and any other inherits. */
  tone?: TextTone;
  as?: 'p' | 'span' | 'div' | 'dd' | 'dt' | 'li';
  children: React.ReactNode;
}

/** Text in a type role's face, size, line height and weight, as the element given. */
export function Text({
  variant,
  tone,
  as = 'p',
  children,
}: Readonly<TextProps>): React.JSX.Element {
  const Element = as;
  const resolvedTone = tone ?? TYPE_ROLES[variant].tone ?? 'default';
  return (
    <Element className={`${typeRoleClass(variant)}${TONE_CLASS[resolvedTone]}`}>{children}</Element>
  );
}
