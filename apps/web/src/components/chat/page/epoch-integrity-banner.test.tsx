import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { clearEpochKeyCache, setEpochKey } from '@/lib/crypto/epoch-key-cache';
import { EpochIntegrityBanner } from '@/components/chat/page/epoch-integrity-banner';
import type { EpochVerdict } from '@/lib/crypto/epoch-key-cache';

const CONVERSATION_ID = 'conv-epoch';

function verdictOf(overrides: Partial<EpochVerdict>): EpochVerdict {
  return {
    currentEpoch: 3,
    rotationPending: false,
    rotation: 'ok',
    lastGoodEpoch: 3,
    badEpochs: new Set<number>(),
    ...overrides,
  };
}

const BAD: Partial<EpochVerdict> = { rotation: 'bad', lastGoodEpoch: 2, badEpochs: new Set([3]) };

describe('EpochIntegrityBanner', () => {
  beforeEach(() => {
    clearEpochKeyCache();
  });

  it('renders nothing before the keychain has been judged', () => {
    const { container } = render(
      <EpochIntegrityBanner
        verdict={undefined}
        conversationId={CONVERSATION_ID}
        isLinkGuest={false}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('marks a verified keychain for specs without showing anything', () => {
    render(
      <EpochIntegrityBanner
        verdict={verdictOf({})}
        conversationId={CONVERSATION_ID}
        isLinkGuest={false}
      />
    );

    const banner = screen.getByTestId(TEST_IDS.epochIntegrityBanner);
    expect(banner).toHaveAttribute(TEST_SIGNALS.epochState, 'verified');
    expect(banner).not.toBeVisible();
  });

  it('announces a pending rotation politely', () => {
    render(
      <EpochIntegrityBanner
        verdict={verdictOf({ rotationPending: true })}
        conversationId={CONVERSATION_ID}
        isLinkGuest={false}
      />
    );

    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('data-testid', TEST_IDS.epochIntegrityBanner);
    expect(banner).toHaveAttribute(TEST_SIGNALS.epochState, 'pending');
    expect(banner).toHaveTextContent(
      "A member left. Sending is paused while this conversation's keys update."
    );
  });

  it('shows a link guest the same pending state', () => {
    render(
      <EpochIntegrityBanner
        verdict={verdictOf({ rotationPending: true })}
        conversationId={CONVERSATION_ID}
        isLinkGuest={true}
      />
    );

    expect(screen.getByRole('status')).toHaveAttribute(TEST_SIGNALS.epochState, 'pending');
  });

  it('alerts that the keys are being restored when this client holds the last good key', () => {
    setEpochKey(CONVERSATION_ID, 2, new Uint8Array(32).fill(2));

    render(
      <EpochIntegrityBanner
        verdict={verdictOf(BAD)}
        conversationId={CONVERSATION_ID}
        isLinkGuest={false}
      />
    );

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('data-testid', TEST_IDS.epochIntegrityBanner);
    expect(banner).toHaveAttribute(TEST_SIGNALS.epochState, 'bad');
    expect(banner).toHaveTextContent(
      "This conversation's newest keys failed verification. Restoring the last working keys, and sending is paused until then."
    );
  });

  it('alerts a bad rotation over a pending one', () => {
    setEpochKey(CONVERSATION_ID, 2, new Uint8Array(32).fill(2));

    render(
      <EpochIntegrityBanner
        verdict={verdictOf({ ...BAD, rotationPending: true })}
        conversationId={CONVERSATION_ID}
        isLinkGuest={false}
      />
    );

    expect(screen.getByRole('alert')).toHaveAttribute(TEST_SIGNALS.epochState, 'bad');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('asks for an earlier member when no key verified below the bad epoch', () => {
    render(
      <EpochIntegrityBanner
        verdict={verdictOf({ ...BAD, lastGoodEpoch: null })}
        conversationId={CONVERSATION_ID}
        isLinkGuest={false}
      />
    );

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute(TEST_SIGNALS.epochState, 'bad');
    expect(banner).toHaveTextContent(
      "This conversation's newest keys failed verification and can't be restored from this device. Ask a member who joined before you to open it."
    );
  });

  it('asks for an earlier member when this client lacks the last good key', () => {
    render(
      <EpochIntegrityBanner
        verdict={verdictOf(BAD)}
        conversationId={CONVERSATION_ID}
        isLinkGuest={false}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Ask a member who joined before you');
  });

  it('asks a link guest for a member even when it holds the last good key', () => {
    setEpochKey(CONVERSATION_ID, 2, new Uint8Array(32).fill(2));

    render(
      <EpochIntegrityBanner
        verdict={verdictOf(BAD)}
        conversationId={CONVERSATION_ID}
        isLinkGuest={true}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Ask a member who joined before you');
  });
});
