import { TEST_IDS } from '@hushbox/shared';
import { Lock } from '@hushbox/ui/icons';
import { Heading, Text } from '@hushbox/ui/type';
import { TrustLine } from '@/components/shared/trust-line';
import type * as React from 'react';

interface ShareHeadProps {
  title: string;
  /** Who shared the page, or what it holds; omitted, the head draws no meta line. */
  meta?: string;
  /** False on a page that decrypted nothing, where the promise would not be true. */
  showTrustLine?: boolean;
}

/**
 * The head of a shared page: its title, an optional line of who or what, and the
 * promise that the page was decrypted here with the link's key.
 */
export function ShareHead({
  title,
  meta,
  showTrustLine = true,
}: Readonly<ShareHeadProps>): React.JSX.Element {
  return (
    <header
      data-testid={TEST_IDS.shareHead}
      className="border-border mb-7 flex flex-col items-center gap-2 border-b pt-2 pb-6 text-center"
    >
      <Heading level={1} variant="share-title">
        {title}
      </Heading>
      {meta === undefined ? null : (
        <Text variant="ui-sm" tone="muted">
          {meta}
        </Text>
      )}
      {showTrustLine && (
        <TrustLine icon={Lock} align="center" size="ui-sm">
          Decrypted in this browser with the key in your link. HushBox&apos;s servers never receive
          that key.
        </TrustLine>
      )}
    </header>
  );
}
