import * as React from 'react';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { Alert } from '@hushbox/ui';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { recoveryPredecessor } from '@/hooks/crypto/use-epoch-maintenance';
import type { EpochVerdict } from '@/lib/crypto/epoch-key-cache';

type BannerState = 'verified' | 'pending' | 'recovering' | 'cannot-recover';

interface EpochIntegrityBannerProps {
  readonly verdict: EpochVerdict | undefined;
  readonly conversationId: string | null;
  readonly isLinkGuest: boolean;
}

/** A link guest never rotates, so it can never be the client recovering. */
function bannerState(
  verdict: EpochVerdict,
  conversationId: string | null,
  isLinkGuest: boolean
): BannerState {
  if (verdict.rotation === 'bad') {
    const recovering =
      !isLinkGuest &&
      conversationId !== null &&
      recoveryPredecessor(conversationId, verdict) !== undefined;
    return recovering ? 'recovering' : 'cannot-recover';
  }
  return verdict.rotationPending ? 'pending' : 'verified';
}

const ALERT_COPY: Record<'recovering' | 'cannot-recover', string> = {
  recovering:
    "This conversation's newest keys failed verification. Restoring the last working keys, and sending is paused until then.",
  'cannot-recover':
    "This conversation's newest keys failed verification and can't be restored from this device. Ask a member who joined before you to open it.",
};

/**
 * The conversation's key state, above the thread: why the composer is closed
 * while a departure awaits its rotation or a rotation failed verification. A
 * verified keychain renders nothing visible, but still carries the state for
 * the specs that wait on it.
 */
export function EpochIntegrityBanner({
  verdict,
  conversationId,
  isLinkGuest,
}: EpochIntegrityBannerProps): React.JSX.Element | null {
  if (verdict === undefined) return null;
  const state = bannerState(verdict, conversationId, isLinkGuest);
  const signal = {
    'data-testid': TEST_IDS.epochIntegrityBanner,
    [TEST_SIGNALS.epochState]: state === 'verified' || state === 'pending' ? state : 'bad',
  };

  if (state === 'verified') return <div hidden {...signal} />;

  return (
    <div className="shrink-0 px-4 pt-3">
      {state === 'pending' ? (
        <Alert variant="default" emphasis="strong" className="mx-auto max-w-3xl" {...signal}>
          <KeyRound aria-hidden="true" />
          <span className="text-pretty wrap-anywhere">
            A member left. Sending is paused while this conversation&apos;s keys update.
          </span>
        </Alert>
      ) : (
        <Alert variant="destructive" emphasis="strong" className="mx-auto max-w-3xl" {...signal}>
          <ShieldAlert aria-hidden="true" />
          <span className="text-pretty wrap-anywhere">{ALERT_COPY[state]}</span>
        </Alert>
      )}
    </div>
  );
}
