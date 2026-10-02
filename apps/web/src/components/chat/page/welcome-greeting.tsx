import { motion } from 'framer-motion';
import { cn, useReducedMotion } from '@hushbox/ui';
import { MOTION_TRANSITION } from '@hushbox/ui/motion';
import { Heading } from '@hushbox/ui/type';
import { MOTION } from '@hushbox/shared/design-tokens';
import { TypingAnimation } from '@/components/chat/indicators/typing-animation';
import type * as React from 'react';
import type { getGreeting } from '@/lib/chat/greetings';

type Greeting = ReturnType<typeof getGreeting>;

interface WelcomeGreetingProps {
  /** Null while the session settles; the greeting's two lines keep their height meanwhile. */
  greeting: Greeting | null;
  showSubtitle: boolean;
  onTypingComplete: () => void;
}

const SUBTITLE_CLASS = 'text-muted-foreground mt-4 text-lg';

/** The sub-greeting rises into place a beat after the greeting finishes typing. */
const SUBTITLE_TRANSITION = { ...MOTION_TRANSITION.deliberate, delay: MOTION.baseMs / 1000 };

/**
 * The new chat's greeting, typed out, then its sub-greeting. The sub-greeting shows at
 * once, with no motion, when motion is reduced.
 */
export function WelcomeGreeting({
  greeting,
  showSubtitle,
  onTypingComplete,
}: Readonly<WelcomeGreetingProps>): React.JSX.Element {
  const animated = !useReducedMotion();
  const subtitle = greeting?.subtitle ?? ' ';
  return (
    <div className="text-center" data-reading="">
      <Heading level={1} variant="chat-greeting">
        {greeting ? (
          <>
            {/* The animation's own copies are hidden from assistive technology, so the
                heading takes its name from this whole greeting instead. */}
            <span className="sr-only">{greeting.title}</span>
            <span aria-hidden="true">
              <TypingAnimation
                text={greeting.title}
                typingSpeed={75}
                loop={false}
                onComplete={onTypingComplete}
              />
            </span>
          </>
        ) : (
          <span className="invisible">Loading...</span>
        )}
      </Heading>
      {animated ? (
        <motion.p
          data-animated="true"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: showSubtitle ? 1 : 0, y: showSubtitle ? 0 : 10 }}
          transition={SUBTITLE_TRANSITION}
          className={SUBTITLE_CLASS}
        >
          {subtitle}
        </motion.p>
      ) : (
        <p data-animated="false" className={cn(SUBTITLE_CLASS, !showSubtitle && 'opacity-0')}>
          {subtitle}
        </p>
      )}
    </div>
  );
}
