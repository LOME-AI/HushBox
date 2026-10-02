import { Textarea, cn } from '@hushbox/ui';
import { InlineInput } from '@hushbox/ui/field';
import type { ComponentProps, JSX } from 'react';

/**
 * `twMerge` does not treat `text-base` and `md:text-sm` as conflicting: they are
 * different variants, so both survive and `md:` wins at ≥768px. The shared
 * primitives ship shadcn's `text-base md:text-sm`, so asking for body size without
 * saying "at every width" leaves a field at 14px on exactly the viewport this
 * console is read on. Naming both is what makes the body size actually reachable.
 */
const CONSOLE_FIELD_TEXT_CLASSES = 'text-base md:text-base';

export function ConsoleInput({
  className,
  ...props
}: ComponentProps<typeof InlineInput>): JSX.Element {
  return <InlineInput className={cn(CONSOLE_FIELD_TEXT_CLASSES, className)} {...props} />;
}

export function ConsoleTextarea({
  className,
  ...props
}: ComponentProps<typeof Textarea>): JSX.Element {
  return <Textarea className={cn(CONSOLE_FIELD_TEXT_CLASSES, className)} {...props} />;
}
