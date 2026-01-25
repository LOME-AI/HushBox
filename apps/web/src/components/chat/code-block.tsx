import * as React from 'react';
import { Button, cn } from '@lome-chat/ui';
import { Check, Copy } from 'lucide-react';

interface CodeBlockProps {
  children: string;
  language?: string | undefined;
  className?: string;
  variant?: 'default' | 'transparent';
  hideHeader?: boolean;
}

export function CodeBlock({
  children,
  language,
  className,
  variant = 'default',
  hideHeader = false,
}: Readonly<CodeBlockProps>): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async (): Promise<void> => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  return (
    <div
      data-testid="code-block"
      className={cn(
        'group relative max-w-full rounded-lg',
        variant === 'transparent' ? 'bg-transparent' : 'bg-zinc-900',
        className
      )}
    >
      {/* Header with language label and copy button */}
      {!hideHeader && (
        <div className="border-border flex items-center justify-between border-b px-4 py-2">
          {language ? (
            <span data-testid="language-label" className="text-muted-foreground text-xs">
              {language}
            </span>
          ) : (
            <span />
          )}
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground h-6 w-6"
            onClick={() => void handleCopy()}
            aria-label={copied ? 'Copied' : 'Copy code'}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </Button>
        </div>
      )}

      {/* Code content */}
      <pre className="overflow-x-auto p-4">
        <code className="text-foreground text-sm">{children}</code>
      </pre>
    </div>
  );
}
