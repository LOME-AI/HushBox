import * as React from 'react';
import { cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { TypingAnimation } from '@/components/chat/indicators/typing-animation';

interface AnimatedPlaceholderProps {
  text: string;
  className?: string;
}

/**
 * Visual overlay rendered above an empty Textarea to imitate a native placeholder
 * with a typing-caret animation. The parent decides when to mount it (i.e. only
 * while the textarea value is empty) so the animation is a no-op once the user
 * starts typing. `aria-hidden` because the underlying textarea already exposes
 * the placeholder string as its `aria-label`; this overlay is decorative.
 *
 * Positional defaults (`top-2 left-3`, `text-base md:text-sm`) mirror the shadcn
 * Textarea's `px-3 py-2` padding and font sizing so the typed glyphs sit exactly
 * where the native placeholder would render.
 */
export function AnimatedPlaceholder({
  text,
  className,
}: Readonly<AnimatedPlaceholderProps>): React.JSX.Element {
  return (
    <span
      data-testid={TEST_IDS.animatedPlaceholder}
      aria-hidden="true"
      className={cn(
        'text-muted-foreground pointer-events-none absolute top-2 left-3 text-base whitespace-nowrap select-none md:text-sm',
        className
      )}
    >
      <TypingAnimation text={text} loop={false} skipInitialTyping />
    </span>
  );
}
