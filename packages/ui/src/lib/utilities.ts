import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import { TYPE_ROLES } from '@hushbox/shared/design-tokens';

// The default config files an unknown `text-<name>` under text colour, so a type-role
// class merged with a colour class would be dropped; the roles are font sizes.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: Object.keys(TYPE_ROLES) } },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
