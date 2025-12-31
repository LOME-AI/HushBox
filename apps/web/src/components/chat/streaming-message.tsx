import * as React from 'react';
import { cn } from '@lome-chat/ui';
import { MarkdownRenderer } from './markdown-renderer';

interface StreamingMessageProps {
  content: string;
  isStreaming?: boolean;
  className?: string;
}

/** Chars per second per buffered char - controls linear speed scaling */
const SPEED_FACTOR = 5;

/**
 * Calculate typing delay based on buffer size and character.
 * Speed scales linearly with buffer - more buffer = faster typing.
 * Zero buffer = wait for more data.
 */
export function calculateDelay(char: string, bufferSize: number): number {
  // No buffer = wait for more data (poll delay)
  if (bufferSize <= 0) {
    return 50;
  }

  // Linear speed: chars/sec proportional to buffer
  const charsPerSecond = bufferSize * SPEED_FACTOR;
  let delay = 1000 / charsPerSecond;

  // Human cadence: add pauses at natural break points
  if ('.!?'.includes(char)) {
    delay += 80 + Math.random() * 70;
  } else if (',;:'.includes(char)) {
    delay += 20 + Math.random() * 30;
  } else if (char === ' ') {
    delay += 30 + Math.random() * 50;
  }

  // Random variation ±20% for natural feel
  delay *= 0.8 + Math.random() * 0.4;

  return Math.max(delay, 5); // minimum 5ms
}

/**
 * Custom hook that creates a human-like typing effect with buffer-aware speed.
 * Speed scales linearly with buffer size - more buffer = faster typing.
 * Zero buffer while streaming = wait for more data.
 */
function useTypingEffect(targetContent: string, isStreaming: boolean): string {
  const [displayedContent, setDisplayedContent] = React.useState('');
  const displayedLengthRef = React.useRef(0);
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const targetRef = React.useRef(targetContent);

  // Keep ref updated with latest content (no effect re-run needed)
  targetRef.current = targetContent;

  React.useEffect(() => {
    // Only clear/restart when streaming state changes
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    const typeNextChar = (): void => {
      const target = targetRef.current; // Read from ref for latest content
      const currentLength = displayedLengthRef.current;
      const bufferSize = target.length - currentLength;

      if (bufferSize > 0) {
        // We have content to display
        // Safe: bufferSize > 0 guarantees currentLength < target.length
        const nextChar = target.charAt(currentLength);
        displayedLengthRef.current += 1;
        setDisplayedContent(target.slice(0, displayedLengthRef.current));

        // Calculate delay based on remaining buffer (after consuming this char)
        const delay = calculateDelay(nextChar, bufferSize - 1);
        timeoutRef.current = setTimeout(typeNextChar, delay);
      } else if (isStreaming) {
        // Buffer empty but still streaming - poll for more
        timeoutRef.current = setTimeout(typeNextChar, 50);
      }
      // If buffer empty and not streaming, we're done
    };

    // Start the typing loop
    typeNextChar();

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [isStreaming]); // Only depend on isStreaming, NOT targetContent

  // When streaming stops, immediately show all remaining content
  React.useEffect(() => {
    if (!isStreaming && displayedLengthRef.current < targetContent.length) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      displayedLengthRef.current = targetContent.length;
      setDisplayedContent(targetContent);
    }
  }, [isStreaming, targetContent]);

  return displayedContent;
}

/**
 * Displays a streaming AI response with a human-like typing effect and blinking cursor.
 * Used during SSE streaming to show partial responses.
 */
export function StreamingMessage({
  content,
  isStreaming = true,
  className,
}: StreamingMessageProps): React.JSX.Element {
  const displayedContent = useTypingEffect(content, isStreaming);

  return (
    <div data-testid="streaming-message-container" className={cn('w-full px-[2%] py-3', className)}>
      <div data-testid="streaming-message" className="text-foreground px-4 py-2">
        <div className="text-base leading-relaxed">
          <MarkdownRenderer content={displayedContent} />
          {isStreaming && (
            <span
              data-testid="streaming-indicator"
              className="animate-blink bg-foreground ml-0.5 inline-block h-5 w-0.5 align-text-bottom"
              aria-label="Generating response"
            />
          )}
        </div>
      </div>
    </div>
  );
}
