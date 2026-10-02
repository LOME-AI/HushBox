import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';

import { useCopyToClipboard } from '../../hooks/use-copy-to-clipboard';
import { IconButton } from './icon-button';

/** Density convention: monospace id with a copy button beside it. */
function CopyableId({
  value,
  label,
}: Readonly<{
  value: string;
  /** What is being copied, for the button's accessible name. */
  label: string;
}>): React.JSX.Element {
  const { copy, copied } = useCopyToClipboard();
  return (
    <span data-slot="copyable-id" className="inline-flex items-center gap-1">
      {/* nowrap, never break-all: a wrapped uuid reads as two ids; wide tables
          scroll in their own containers instead. */}
      <span title={value} className="font-mono text-xs whitespace-nowrap">
        {value}
      </span>
      <IconButton
        data-testid={TEST_IDS.adminCopyId}
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
        onClick={() => {
          void copy(value);
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </IconButton>
    </span>
  );
}

export { CopyableId };
