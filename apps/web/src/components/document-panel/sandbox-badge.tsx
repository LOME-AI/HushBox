import { ShieldCheck } from '@hushbox/ui/icons';
import { TrustLine } from '@/components/shared/trust-line';
import type * as React from 'react';

/** The promise under a document's output: its code runs walled off from the reader's account. */
export function SandboxBadge(): React.JSX.Element {
  return <TrustLine icon={ShieldCheck}>Sandboxed. It can&apos;t reach your account.</TrustLine>;
}
