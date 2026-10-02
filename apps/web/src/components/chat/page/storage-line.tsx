import { Lock, ShieldCheck } from '@hushbox/ui/icons';
import { TEST_IDS } from '@hushbox/shared';
import { TrustLine } from '@/components/shared/trust-line';
import type * as React from 'react';

interface StorageLineProps {
  signedIn: boolean;
}

/** What the new chat promises about storage: an account's is kept encrypted, a visitor's is not kept. */
export function StorageLine({ signedIn }: Readonly<StorageLineProps>): React.JSX.Element {
  return (
    <div data-testid={TEST_IDS.storageLine}>
      {signedIn ? (
        <TrustLine icon={Lock} size="ui-sm" align="center">
          Saved encrypted with a key only your devices hold. AI providers retain nothing.
        </TrustLine>
      ) : (
        <TrustLine icon={ShieldCheck} size="ui-sm" align="center">
          {'AI providers retain nothing · Sign up for encrypted storage'}
        </TrustLine>
      )}
    </div>
  );
}
