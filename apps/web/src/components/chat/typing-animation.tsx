import * as React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@hushbox/ui';

interface TypingAnimationProps {
  text: string;
  typingSpeed?: number;
  className?: string;
  loop?: boolean;
  onComplete?: () => void;
}

export function TypingAnimation({
  text,
  typingSpeed = 75,
  className,
  loop = true,
  onComplete,
}: Readonly<TypingAnimationProps>): React.JSX.Element {
  const [displayText, setDisplayText] = React.useState('');
  const [isComplete, setIsComplete] = React.useState(false);

  React.useEffect(() => {
    // Reset when text changes
    setDisplayText('');
    setIsComplete(false);
  }, [text]);

  React.useEffect(() => {
    if (isComplete || displayText.length >= text.length) {
      // Typing complete - set state if we just finished
      if (!isComplete && displayText.length >= text.length) {
        setIsComplete(true);
        onComplete?.();
      }
      return;
    }

    const timeout = setTimeout(() => {
      setDisplayText(text.slice(0, Math.max(0, displayText.length + 1)));
    }, typingSpeed);
    return (): void => {
      clearTimeout(timeout);
    };
  }, [displayText, text, typingSpeed, isComplete, onComplete]);

  const showCursor = loop || displayText.length < text.length;

  return (
    <span data-testid="typing-animation" className={cn('relative inline-block', className)}>
      {/* Full text reserves layout space — prevents CLS as characters appear */}
      <span className="invisible select-none" aria-hidden="true">
        {text}
      </span>
      {/* Typed text overlaid at same position */}
      <span data-testid="typed-text" className="absolute top-0 left-0">
        {displayText}
        {showCursor && (
          <motion.span
            data-testid="typing-cursor"
            animate={{ opacity: [1, 0] }}
            transition={{ duration: 0.5, repeat: Infinity, repeatType: 'reverse' }}
            className="ml-0.5 inline-block h-[1em] w-0.5 bg-current align-middle"
          />
        )}
      </span>
    </span>
  );
}
