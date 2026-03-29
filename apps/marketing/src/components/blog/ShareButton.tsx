import * as React from 'react';
import { Check, Link2 } from 'lucide-react';

function ShareButton(): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(globalThis.location.href);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // Clipboard API unavailable in insecure contexts — fail silently
    }
  }

  return (
    <button
      type="button"
      onClick={(): void => {
        void handleCopy();
      }}
      className="text-foreground-muted hover:text-foreground inline-flex shrink-0 items-center gap-2 text-sm whitespace-nowrap transition-colors"
    >
      {copied ? (
        <>
          <Check className="h-4 w-4" />
          Copied!
        </>
      ) : (
        <>
          <Link2 className="h-4 w-4" />
          Copy link
        </>
      )}
    </button>
  );
}

export { ShareButton };
