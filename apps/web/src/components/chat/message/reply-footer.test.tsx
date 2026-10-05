import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { TEST_DAY_START, freezeClock, isoAt } from '@hushbox/shared/test-time';
import { ReplyFooter } from '@/components/chat/message/reply-footer';
import type { Message } from '@/lib/api/api';

const REFERENCE_DAY = new Date(TEST_DAY_START);

/** An instant on the local calendar of the reference day; it follows a stubbed timezone. */
function localInstant(dayOffset: number, hours: number, minutes = 0): number {
  return new Date(
    REFERENCE_DAY.getUTCFullYear(),
    REFERENCE_DAY.getUTCMonth(),
    REFERENCE_DAY.getUTCDate() + dayOffset,
    hours,
    minutes
  ).getTime();
}

function reply(overrides: Partial<Message> = {}): Message {
  return {
    id: 'reply-1',
    conversationId: 'conv-1',
    role: 'assistant',
    content: 'An answer',
    createdAt: isoAt(localInstant(0, 1)),
    ...overrides,
  };
}

const CONTROLS = <div data-testid={TEST_IDS.messageActions}>controls</div>;

/** The footer's meta items, in reading order: each child of the meta line. */
function metaItems(): HTMLElement[] {
  const meta = screen.getByTestId(TEST_IDS.messageActions).parentElement?.firstElementChild;
  if (!(meta instanceof HTMLElement)) throw new Error('Expected the meta line');
  return [...meta.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
}

const DOT_CLASS = 'before:rounded-full';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('ReplyFooter', () => {
  describe('the cost pill', () => {
    it('shows the reply cost', () => {
      render(<ReplyFooter message={reply({ cost: '1360000' })} saved controls={CONTROLS} />);

      expect(screen.getByTestId(TEST_IDS.messageCost)).toHaveTextContent('$0.00136');
    });

    it('shows no pill for a reply that carries no cost, as a link guest reads every reply', () => {
      render(<ReplyFooter message={reply()} saved controls={CONTROLS} />);

      expect(screen.queryByTestId(TEST_IDS.messageCost)).not.toBeInTheDocument();
    });

    it('opens on the reply token counts', async () => {
      render(
        <ReplyFooter
          message={reply({ cost: '11800000', inputTokens: 1862, outputTokens: 412 })}
          saved
          controls={CONTROLS}
        />
      );
      await userEvent.click(screen.getByTestId(TEST_IDS.messageCost));

      const breakdown = screen.getByRole('dialog', { name: 'This reply' });
      expect(
        within(breakdown)
          .getAllByRole('definition')
          .map((d) => d.textContent)
      ).toEqual(['1,862 tokens', '412 tokens', '$0.0118']);
    });
  });

  describe('the storage state', () => {
    it('says Saved encrypted on a stored reply', () => {
      render(<ReplyFooter message={reply()} saved controls={CONTROLS} />);

      expect(screen.getByText('Saved encrypted')).toBeInTheDocument();
    });

    it('marks Saved encrypted with a green lock', () => {
      render(<ReplyFooter message={reply()} saved controls={CONTROLS} />);

      expect(screen.getByText('Saved encrypted').querySelector('svg')).toHaveClass('text-success');
    });

    it('says nothing about storage on a reply that is not stored, as on the trial', () => {
      render(<ReplyFooter message={reply()} saved={false} controls={CONTROLS} />);

      expect(screen.queryByText('Saved encrypted')).not.toBeInTheDocument();
    });
  });

  describe('in a compare group', () => {
    it('shows the cost alone', () => {
      vi.useFakeTimers({ now: localInstant(0, 9), toFake: ['Date'] });
      render(
        <ReplyFooter message={reply({ cost: '1360000' })} saved costOnly controls={CONTROLS} />
      );

      expect(metaItems().map((item) => item.textContent)).toEqual(['$0.00136']);
    });
  });

  describe('a leading control', () => {
    const LEADING = <button type="button">Continue with this model</button>;

    it('starts the control row, ahead of the controls', () => {
      render(
        <ReplyFooter
          message={reply({ cost: '1360000' })}
          saved
          costOnly
          leading={LEADING}
          controls={CONTROLS}
        />
      );

      const leading = screen.getByRole('button', { name: 'Continue with this model' });
      const controls = screen.getByTestId(TEST_IDS.messageActions);
      expect(leading.parentElement).toBe(controls.parentElement);
      expect(leading.nextElementSibling).toBe(controls);
    });

    it('sets the control row after the cost', () => {
      render(
        <ReplyFooter
          message={reply({ cost: '1360000' })}
          saved
          costOnly
          leading={LEADING}
          controls={CONTROLS}
        />
      );

      const row = screen.getByRole('button', { name: 'Continue with this model' }).parentElement;
      expect(row?.previousElementSibling).toContainElement(
        screen.getByTestId(TEST_IDS.messageCost)
      );
    });
  });

  describe('the date', () => {
    it('reads Today for a reply from the current day', () => {
      freezeClock(localInstant(0, 12));
      render(<ReplyFooter message={reply()} saved controls={CONTROLS} />);

      expect(screen.getByText('Today').tagName).toBe('TIME');
    });

    it('reads the date for a reply from an earlier day', () => {
      freezeClock(localInstant(3, 12));
      render(<ReplyFooter message={reply()} saved controls={CONTROLS} />);

      expect(screen.getByText('2026-01-15')).toBeInTheDocument();
    });

    it('states the reply instant as machine-readable time', () => {
      freezeClock(localInstant(0, 12));
      render(<ReplyFooter message={reply()} saved controls={CONTROLS} />);

      expect(screen.getByText('Today')).toHaveAttribute('datetime', isoAt(localInstant(0, 1)));
    });

    it('reads the viewer local calendar in a timezone ahead of UTC', () => {
      vi.stubEnv('TZ', 'Pacific/Auckland');
      const createdMs = localInstant(-1, 23, 30);
      freezeClock(localInstant(0, 0, 30));
      render(
        <ReplyFooter message={reply({ createdAt: isoAt(createdMs) })} saved controls={CONTROLS} />
      );

      expect(new Date(createdMs).getTimezoneOffset()).not.toBe(0);
      expect(screen.getByText('2026-01-14')).toBeInTheDocument();
    });

    it('shows no date for a reply that carries no instant', () => {
      render(<ReplyFooter message={reply({ createdAt: '' })} saved controls={CONTROLS} />);

      expect(screen.queryByText('Today')).not.toBeInTheDocument();
      expect(document.querySelector('time')).toBeNull();
    });

    it('shows no date while the reply streams', () => {
      freezeClock(localInstant(0, 12));
      render(<ReplyFooter message={reply()} saved={false} streaming controls={CONTROLS} />);

      expect(document.querySelector('time')).toBeNull();
    });
  });

  describe('the separator dots', () => {
    it('draws no dot before the first item', () => {
      freezeClock(localInstant(0, 12));
      render(<ReplyFooter message={reply({ cost: '1360000' })} saved controls={CONTROLS} />);

      expect(metaItems()[0]).not.toHaveClass(DOT_CLASS);
    });

    it('draws each later dot on the item it precedes, so it wraps with that item', () => {
      freezeClock(localInstant(0, 12));
      render(<ReplyFooter message={reply({ cost: '1360000' })} saved controls={CONTROLS} />);

      const [, saved, date] = metaItems();
      expect(saved).toHaveClass(DOT_CLASS);
      expect(date).toHaveClass(DOT_CLASS);
    });

    it('draws no dot before Saved encrypted when it leads the line', () => {
      freezeClock(localInstant(0, 12));
      render(<ReplyFooter message={reply()} saved controls={CONTROLS} />);

      const [saved, date] = metaItems();
      expect(saved).toHaveTextContent('Saved encrypted');
      expect(saved).not.toHaveClass(DOT_CLASS);
      expect(date).toHaveClass(DOT_CLASS);
    });

    it('keeps the items in order: cost, storage, date', () => {
      freezeClock(localInstant(0, 12));
      render(<ReplyFooter message={reply({ cost: '1360000' })} saved controls={CONTROLS} />);

      expect(metaItems().map((item) => item.textContent)).toEqual([
        '$0.00136',
        'Saved encrypted',
        'Today',
      ]);
    });
  });

  describe('the row', () => {
    it('puts the controls after the meta line', () => {
      render(<ReplyFooter message={reply({ cost: '1360000' })} saved controls={CONTROLS} />);

      const cost = screen.getByTestId(TEST_IDS.messageCost);
      const controls = screen.getByTestId(TEST_IDS.messageActions);
      expect(cost.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });

    it('holds the touch-sized row open so the controls arrive without moving the thread', () => {
      const { container } = render(
        <ReplyFooter message={reply()} saved={false} streaming controls={null} />
      );

      expect(container.firstElementChild).toHaveClass('min-h-8', 'pointer-coarse:min-h-11');
    });

    it('is tagged as structural chrome', () => {
      render(<ReplyFooter message={reply()} saved controls={CONTROLS} />);

      expect(screen.getByTestId(TEST_IDS.messageActions).parentElement).toHaveAttribute(
        'data-chrome'
      );
    });
  });
});
