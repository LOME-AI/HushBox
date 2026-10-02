import * as React from 'react';
import { cn, TEXTAREA_TYPE_SCALE_CLASSES } from '@hushbox/ui';
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
        // `top-2 left-3` is this overlay's own absolute offset, not the
        // textarea's `px-3 py-2` padding. The two agree numerically because
        // they draw on the same spacing scale, and sharing one definition
        // would invent a coupling between properties free to move apart.
        'text-muted-foreground pointer-events-none absolute top-2 left-3 whitespace-nowrap select-none',
        TEXTAREA_TYPE_SCALE_CLASSES,
        className
      )}
    >
      <TypingAnimation text={text} loop={false} skipInitialTyping />
    </span>
  );
}
