import * as React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@lome-chat/ui';

interface TypingAnimationProps {
  text: string;
  typingSpeed?: number;
  className?: string;
  loop?: boolean;
  onComplete?: () => void;
}

export function TypingAnimation({
  text,
  typingSpeed = 50,
  className,
  loop = true,
  onComplete,
}: TypingAnimationProps): React.JSX.Element {
  const [displayText, setDisplayText] = React.useState('');
  const [isComplete, setIsComplete] = React.useState(false);

  React.useEffect(() => {
    // Reset when text changes
    setDisplayText('');
    setIsComplete(false);
  }, [text]);

  React.useEffect(() => {
    if (isComplete) {
      return undefined;
    }

    if (displayText.length < text.length) {
      const timeout = setTimeout(() => {
        setDisplayText(text.substring(0, displayText.length + 1));
      }, typingSpeed);
      return (): void => {
        clearTimeout(timeout);
      };
    }

    // Typing complete
    setIsComplete(true);
    onComplete?.();
    return undefined;
  }, [displayText, text, typingSpeed, isComplete, onComplete]);

  const showCursor = loop || !isComplete;

  return (
    <span data-testid="typing-animation" className={cn('relative inline', className)}>
      <span data-testid="typed-text">{displayText}</span>
      {showCursor && (
        <motion.span
          data-testid="typing-cursor"
          animate={{ opacity: [1, 0] }}
          transition={{ duration: 0.5, repeat: Infinity, repeatType: 'reverse' }}
          className="ml-0.5 inline-block h-[1em] w-0.5 bg-current align-middle"
        />
      )}
    </span>
  );
}
