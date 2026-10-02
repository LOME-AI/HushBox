import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ROUTES, TEST_IDS, friendlyErrorMessage, noticeText } from '@hushbox/shared';
import { turnNoticeForCode, turnNoticeText, type TurnNotice } from '@/lib/chat/turn-notice';
import { trialRefusalFor } from '@/lib/chat/trial-refusals';
import { TurnNoticeView } from './turn-notice-view';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
  }: Readonly<{ children: React.ReactNode; to: string; className?: string }>) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

function trialLimitNotice(): TurnNotice {
  const refusal = trialRefusalFor({ code: 'TRIAL_LIMIT_REACHED' });
  if (refusal === null) throw new Error('the trial limit is a trial refusal');
  return refusal.notice;
}

const OFFERED: TurnNotice = turnNoticeForCode('UNAVAILABLE');

function textBlockOf(root: HTMLElement): Element {
  const block = root.querySelector('[data-slot="notice"]')?.children[1];
  if (block === undefined) throw new Error('the notice has no text block');
  return block;
}

describe('TurnNoticeView', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      writable: true,
      configurable: true,
    });
  });

  describe('its text', () => {
    it('renders the cause', () => {
      render(<TurnNoticeView placement="tile" notice={OFFERED} />);

      expect(screen.getByText(OFFERED.cause)).toBeInTheDocument();
    });

    it('renders the action', () => {
      render(<TurnNoticeView placement="tile" notice={OFFERED} />);

      const [first] = OFFERED.action;
      expect(screen.getByText(first?.text ?? '')).toBeInTheDocument();
    });

    it('points an action link to its route', () => {
      render(<TurnNoticeView placement="tile" notice={trialLimitNotice()} />);

      expect(screen.getByRole('link', { name: 'Sign up free' })).toHaveAttribute(
        'href',
        ROUTES.SIGNUP
      );
    });

    it("keeps an action link's words together while they fit the column", () => {
      render(<TurnNoticeView placement="tile" notice={trialLimitNotice()} />);

      expect(screen.getByRole('link', { name: 'Sign up free' })).toHaveClass(
        'inline-block',
        'max-w-full'
      );
    });

    it("reads the tile's text block as the cause, one space, then the action", () => {
      const notice = trialLimitNotice();
      render(<TurnNoticeView placement="tile" notice={notice} />);

      expect(textBlockOf(screen.getByTestId(TEST_IDS.turnNoticeTile)).textContent).toBe(
        turnNoticeText(notice)
      );
    });
  });

  describe('its severity', () => {
    it('is an hourglass for a notice that clears on its own', () => {
      render(<TurnNoticeView placement="tile" notice={turnNoticeForCode('CONCURRENT_RUN')} />);

      expect(screen.getByTestId(TEST_IDS.turnNoticeTile)).toHaveAttribute(
        'data-severity',
        'hourglass'
      );
    });

    it('is a circle for a notice the user clears', () => {
      render(<TurnNoticeView placement="tile" notice={OFFERED} />);

      expect(screen.getByTestId(TEST_IDS.turnNoticeTile)).toHaveAttribute(
        'data-severity',
        'circle'
      );
    });
  });

  describe('its placement', () => {
    it('draws the tile as a tile notice', () => {
      render(<TurnNoticeView placement="tile" notice={OFFERED} />);

      expect(
        screen.getByTestId(TEST_IDS.turnNoticeTile).querySelector('[data-slot="notice"]')
      ).toHaveAttribute('data-placement', 'tile');
    });

    it('draws the slot as a slot notice', () => {
      render(<TurnNoticeView placement="slot" notice={OFFERED} />);

      expect(
        screen.getByTestId(TEST_IDS.modelErrorMessage).closest('[data-slot="notice"]')
      ).toHaveAttribute('data-placement', 'slot');
    });

    it("tags the slot's text block, whose text is the code's sentence", () => {
      render(
        <TurnNoticeView
          placement="slot"
          notice={turnNoticeForCode('STREAM_ERROR')}
          onRegenerate={vi.fn()}
        />
      );

      expect(screen.getByTestId(TEST_IDS.modelErrorMessage).textContent).toBe(
        friendlyErrorMessage('STREAM_ERROR')
      );
    });

    it('does not tag the slot as a tile', () => {
      render(<TurnNoticeView placement="slot" notice={OFFERED} />);

      expect(screen.queryByTestId(TEST_IDS.turnNoticeTile)).not.toBeInTheDocument();
    });
  });

  describe('Regenerate', () => {
    it('calls the handler', () => {
      const onRegenerate = vi.fn();
      render(<TurnNoticeView placement="tile" notice={OFFERED} onRegenerate={onRegenerate} />);

      fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

      expect(onRegenerate).toHaveBeenCalledOnce();
    });

    it('renders in the slot', () => {
      render(<TurnNoticeView placement="slot" notice={OFFERED} onRegenerate={vi.fn()} />);

      expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
    });

    it('does not render when the notice withholds it', () => {
      render(
        <TurnNoticeView placement="tile" notice={trialLimitNotice()} onRegenerate={vi.fn()} />
      );

      expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
    });

    it('does not render without a handler', () => {
      render(<TurnNoticeView placement="tile" notice={OFFERED} />);

      expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
    });

    describe('refused by the send gate', () => {
      function renderRefused(onRegenerate: () => void): HTMLElement {
        render(
          <TurnNoticeView
            placement="tile"
            notice={OFFERED}
            onRegenerate={onRegenerate}
            regenerateRefusal="send_cannot_start"
          />
        );
        return screen.getByRole('button', { name: 'Regenerate' });
      }

      it('is marked disabled', () => {
        expect(renderRefused(vi.fn())).toHaveAttribute('aria-disabled', 'true');
      });

      it('is described by the refusal', () => {
        expect(renderRefused(vi.fn())).toHaveAccessibleDescription(noticeText('send_cannot_start'));
      });

      it('explains the refusal in its tooltip', async () => {
        const user = userEvent.setup();
        await user.hover(renderRefused(vi.fn()));

        expect(await screen.findByRole('tooltip')).toHaveTextContent(
          noticeText('send_cannot_start')
        );
      });

      it('does not call the handler on press', () => {
        const onRegenerate = vi.fn();
        fireEvent.click(renderRefused(onRegenerate));

        expect(onRegenerate).not.toHaveBeenCalled();
      });

      it("keeps the refusal out of the notice's text", () => {
        render(
          <TurnNoticeView
            placement="slot"
            notice={turnNoticeForCode('STREAM_ERROR')}
            onRegenerate={vi.fn()}
            regenerateRefusal="send_cannot_start"
          />
        );

        expect(screen.getByTestId(TEST_IDS.modelErrorMessage).textContent).toBe(
          friendlyErrorMessage('STREAM_ERROR')
        );
      });
    });
  });

  describe('Copy', () => {
    it('writes the plain sentence', async () => {
      const notice = trialLimitNotice();
      render(<TurnNoticeView placement="tile" notice={notice} />);

      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await act(async () => {
        await Promise.resolve();
      });

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(turnNoticeText(notice));
    });

    it('shows that it copied', async () => {
      render(<TurnNoticeView placement="slot" notice={OFFERED} />);

      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    });
  });
});
