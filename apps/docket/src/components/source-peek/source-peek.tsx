import { useCallback, useMemo } from 'react';
import { toast, useCopyToClipboard } from '@hushbox/ui';
import { Peek } from '@hushbox/ui/popover';
import { useAuditAddress } from '@/api/audit-address';
import { PeekContent } from './peek-content';
import { createSourceReader } from './source-window';
import { useCitationPeek } from './use-citation-peek';
import { useCitationTabStops } from './use-citation-tab-stops';
import type { SourceReader } from './source-window';
import type { JSX } from 'react';

interface SourcePeekProps {
  readonly read?: SourceReader;
  readonly copy?: (text: string) => void;
}

/**
 * The peek layer for the whole console: one peek, moved to whichever citation
 * the reader is on. It takes no pointer events, so a peek sitting over the
 * control the reader is reaching for does not take the click.
 */
export function SourcePeek({ read, copy }: SourcePeekProps): JSX.Element {
  const clipboard = useCopyToClipboard();
  const audit = useAuditAddress();
  // Keyed on the audit, so the windows read against one repository state are
  // not served to a reader who has moved to another audit.
  const reader = useMemo(() => read ?? createSourceReader(audit), [audit, read]);
  const copyCitation = useCallback(
    (text: string): void => {
      void clipboard.copy(text);
      toast(`Copied ${text}`);
    },
    [clipboard]
  );

  const { peek, close } = useCitationPeek({ read: reader, copy: copy ?? copyCitation });
  useCitationTabStops();

  return (
    <Peek anchor={peek?.citation.element ?? null} onDismiss={close}>
      {peek !== null && <PeekContent citation={peek.citation} outcome={peek.outcome} />}
    </Peek>
  );
}
