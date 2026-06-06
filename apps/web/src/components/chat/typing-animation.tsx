import * as React from 'react';
import { motion } from 'framer-motion';
import { cn, useReducedMotion } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';

export type TypingState = 'idle' | 'typing' | 'deleting';

interface TypingAnimationProps {
  text: string;
  typingSpeed?: number;
  deletionSpeed?: number;
  className?: string;
  loop?: boolean;
  /**
   * When true, the initial render shows the full `text` immediately with no
   * typewriter animation. Subsequent `text` prop changes still trigger the
   * delete-then-retype animation. Use this for pieces that load already
   * "settled" (e.g. suggestion pills) but should animate on later changes
   * (modality switches).
   */
  skipInitialTyping?: boolean;
  onComplete?: () => void;
  onDeleteComplete?: () => void;
  onStateChange?: (state: TypingState) => void;
}

export function TypingAnimation({
  text,
  typingSpeed = 75,
  deletionSpeed = 45,
  className,
  loop = true,
  skipInitialTyping = false,
  onComplete,
  onDeleteComplete,
  onStateChange,
}: Readonly<TypingAnimationProps>): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const startSettled = reducedMotion || skipInitialTyping;
  const [displayText, setDisplayText] = React.useState(startSettled ? text : '');
  const [state, setStateRaw] = React.useState<TypingState>(() => {
    if (startSettled) return 'idle';
    return text.length > 0 ? 'typing' : 'idle';
  });

  // Keep latest callbacks accessible without forcing the timer effect to re-run.
  const onCompleteRef = React.useRef(onComplete);
  const onDeleteCompleteRef = React.useRef(onDeleteComplete);
  const onStateChangeRef = React.useRef(onStateChange);
  React.useEffect(() => {
    onCompleteRef.current = onComplete;
    onDeleteCompleteRef.current = onDeleteComplete;
    onStateChangeRef.current = onStateChange;
  }, [onComplete, onDeleteComplete, onStateChange]);

  const setState = React.useCallback((next: TypingState) => {
    setStateRaw((current) => {
      if (current === next) return current;
      onStateChangeRef.current?.(next);
      return next;
    });
  }, []);

  // Fire the initial 'typing' state notification on mount when starting non-empty.
  const didMountRef = React.useRef(false);
  React.useEffect(() => {
    if (didMountRef.current) return;
    didMountRef.current = true;
    if (startSettled) return;
    if (text.length > 0) {
      onStateChangeRef.current?.('typing');
    }
  }, [startSettled, text]);

  // Latest displayText accessible from the text-change effect without re-running it
  // each character. We need to read displayText here to decide between typing/deleting
  // when the prop changes, but we don't want that effect re-firing per character.
  const displayTextRef = React.useRef(displayText);
  React.useEffect(() => {
    displayTextRef.current = displayText;
  }, [displayText]);

  // When `text` prop changes, transition into the right state for the new prop.
  React.useEffect(() => {
    if (reducedMotion) {
      setDisplayText(text);
      setState('idle');
      // Reduced motion settles on the full text immediately — fire onComplete
      // so callers gated on typing-finish (e.g. chat-welcome's subtitle reveal)
      // don't get stranded waiting for an animation that never ran.
      onCompleteRef.current?.();
      return;
    }
    const current = displayTextRef.current;
    if (current === text) {
      setState('idle');
    } else if (current.length === 0) {
      setState('typing');
    } else {
      setState('deleting');
    }
  }, [text, reducedMotion, setState]);

  const isTyping = state === 'typing';
  const isDeleting = state === 'deleting';

  React.useEffect(() => {
    if (reducedMotion || !isTyping) return;
    if (displayText === text) {
      setState('idle');
      onCompleteRef.current?.();
      return;
    }
    const timeout = setTimeout(() => {
      setDisplayText(text.slice(0, displayText.length + 1));
    }, typingSpeed);
    return (): void => {
      clearTimeout(timeout);
    };
  }, [isTyping, displayText, text, typingSpeed, reducedMotion, setState]);

  React.useEffect(() => {
    if (reducedMotion || !isDeleting) return;
    if (displayText.length === 0) {
      onDeleteCompleteRef.current?.();
      setState(text.length > 0 ? 'typing' : 'idle');
      return;
    }
    const timeout = setTimeout(() => {
      setDisplayText(displayText.slice(0, -1));
    }, deletionSpeed);
    return (): void => {
      clearTimeout(timeout);
    };
  }, [isDeleting, displayText, text, deletionSpeed, reducedMotion, setState]);

  const showCursor = loop || displayText.length < text.length || state === 'deleting';

  return (
    <span data-testid={TEST_IDS.typingAnimation} className={cn('relative inline-block', className)}>
      {/* Full text reserves layout space *and* is the accessible name — screen
          readers announce the complete string immediately rather than the
          partial typed letters as they appear. */}
      <span className="invisible select-none">{text}</span>
      <span data-testid={TEST_IDS.typedText} aria-hidden="true" className="absolute top-0 left-0">
        {displayText}
        {showCursor && (
          <motion.span
            data-testid={TEST_IDS.typingCursor}
            animate={{ opacity: [1, 0] }}
            transition={{ duration: 0.5, repeat: Infinity, repeatType: 'reverse' }}
            className="ml-0.5 inline-block h-[1em] w-0.5 bg-current align-middle"
          />
        )}
      </span>
    </span>
  );
}
