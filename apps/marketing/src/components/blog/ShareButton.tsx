import * as React from 'react';
import { Check, Link2 } from 'lucide-react';
import { useCopyToClipboard } from '@hushbox/ui';

function ShareButton(): React.JSX.Element {
  const { copy, copied } = useCopyToClipboard();

  return (
    <button
      type="button"
      onClick={(): void => {
        void copy(globalThis.location.href);
      }}
      className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-2 text-sm whitespace-nowrap transition-colors"
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
