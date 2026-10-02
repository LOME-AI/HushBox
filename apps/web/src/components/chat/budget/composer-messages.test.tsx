import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ROUTES, TEST_IDS, TEST_ID_BUILDERS, TRIAL_REMAINING_MESSAGE_ID } from '@hushbox/shared';
import { ComposerMessages } from '@/components/chat/budget/composer-messages';
import { useTrialChatStore } from '@/stores/chat/trial-chat';
import type { BudgetError } from '@hushbox/shared';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

interface TrialRead {
  remaining: number | undefined;
  allowanceUntouched: boolean;
}

const mockUseTrialRemaining =
  vi.fn<(input: { enabled: boolean; runInFlight: boolean }) => TrialRead>();

vi.mock('@/hooks/chat/use-trial-remaining', () => ({
  useTrialRemaining: (input: { enabled: boolean; runInFlight: boolean }): TrialRead =>
    mockUseTrialRemaining(input),
}));

/**
 * The publisher's answer, as the hook returns it. The two fields are set
 * INDEPENDENTLY on purpose: the verdict is the publisher's, so a component that
 * re-derived one from the other would be holding the trial allowance itself,
 * and only a double that can disagree makes that visible.
 */
function trialRead(remaining: number | undefined, allowanceUntouched: boolean): TrialRead {
  return { remaining, allowanceUntouched };
}

const TRIAL_NOTICE: BudgetError = {
  id: 'trial_preview_pays',
  type: 'info',
  message: 'You are chatting in the free preview. Sign up for full access.',
  segments: [
    { text: 'You are chatting in the free preview. ' },
    { text: 'Sign up', link: ROUTES.SIGNUP },
    { text: ' for full access.' },
  ],
};

const BLOCKING_NOTICE: BudgetError = {
  id: 'trial_message_cap_exceeded',
  type: 'error',
  message: 'Sample blocking notice.',
};

function countElement(): HTMLElement {
  return screen.getByTestId(TEST_ID_BUILDERS.budgetMessage(TRIAL_REMAINING_MESSAGE_ID));
}

function renderStack(notices: BudgetError[], isTrial = true, runInFlight = false): void {
  render(<ComposerMessages notices={notices} isTrial={isTrial} runInFlight={runInFlight} />);
}

describe('ComposerMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTrialRemaining.mockReset();
    mockUseTrialRemaining.mockReturnValue(trialRead(undefined, true));
    useTrialChatStore.getState().reset();
  });

  it('renders the composer notices it was given', () => {
    renderStack([TRIAL_NOTICE]);

    expect(
      screen.getByTestId(TEST_ID_BUILDERS.budgetMessage('trial_preview_pays'))
    ).toBeInTheDocument();
  });

  it('says nothing about the count when the read is unavailable', () => {
    mockUseTrialRemaining.mockReturnValue(trialRead(undefined, true));

    renderStack([TRIAL_NOTICE]);

    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.budgetMessage(TRIAL_REMAINING_MESSAGE_ID))
    ).not.toBeInTheDocument();
  });

  it('says nothing to a first-time visitor who still holds the full allowance', () => {
    mockUseTrialRemaining.mockReturnValue(trialRead(5, true));

    renderStack([TRIAL_NOTICE]);

    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.budgetMessage(TRIAL_REMAINING_MESSAGE_ID))
    ).not.toBeInTheDocument();
  });

  it('states the singular count in the free preview', () => {
    mockUseTrialRemaining.mockReturnValue(trialRead(1, false));

    renderStack([TRIAL_NOTICE]);

    expect(countElement()).toHaveTextContent(
      'One message left in your free preview today. Sign up for full access.'
    );
  });

  it('states the plural count in the free preview', () => {
    mockUseTrialRemaining.mockReturnValue(trialRead(3, false));

    renderStack([TRIAL_NOTICE]);

    expect(countElement()).toHaveTextContent(
      '3 messages left in your free preview today. Sign up for full access.'
    );
  });

  // Zero is spelled, not digited, so the boundary reads in the same word-form as
  // the singular above it rather than opening on a bare figure.
  it('states the exhausted count in the free preview', () => {
    mockUseTrialRemaining.mockReturnValue(trialRead(0, false));

    renderStack([TRIAL_NOTICE]);

    expect(countElement()).toHaveTextContent(
      'No messages left in your free preview today. Sign up for full access.'
    );
  });

  it('links the sign-up clause to the sign-up route', () => {
    mockUseTrialRemaining.mockReturnValue(trialRead(3, false));

    renderStack([TRIAL_NOTICE]);

    expect(screen.getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', ROUTES.SIGNUP);
  });

  it('replaces the free-preview notice instead of stacking beside it', () => {
    mockUseTrialRemaining.mockReturnValue(trialRead(3, false));

    renderStack([TRIAL_NOTICE]);

    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.budgetMessage('trial_preview_pays'))
    ).not.toBeInTheDocument();
    expect(countElement()).toBeInTheDocument();
  });

  it('takes the free-preview notice place in the stack', () => {
    mockUseTrialRemaining.mockReturnValue(trialRead(3, false));

    renderStack([BLOCKING_NOTICE, TRIAL_NOTICE]);

    const rendered = screen
      .getByTestId(TEST_IDS.budgetMessages)
      .querySelectorAll<HTMLElement>('[role="alert"]');
    expect([...rendered].map((element) => element.dataset['testid'])).toEqual([
      TEST_ID_BUILDERS.budgetMessage('trial_message_cap_exceeded'),
      TEST_ID_BUILDERS.budgetMessage(TRIAL_REMAINING_MESSAGE_ID),
    ]);
  });

  it('states the count even where no free-preview notice was raised', () => {
    mockUseTrialRemaining.mockReturnValue(trialRead(2, false));

    renderStack([BLOCKING_NOTICE]);

    expect(countElement()).toBeInTheDocument();
  });

  it('gives the count a notice treatment it can dismiss', () => {
    mockUseTrialRemaining.mockReturnValue(trialRead(2, false));

    renderStack([TRIAL_NOTICE]);

    expect(
      screen.getByTestId(TEST_ID_BUILDERS.budgetDismiss(TRIAL_REMAINING_MESSAGE_ID))
    ).toBeInTheDocument();
  });

  it('states the count on the publisher’s verdict rather than a comparison of its own', () => {
    // The count here is the FULL allowance, which the component used to read as
    // "nothing spent yet". Only the publisher knows that, and here it says the
    // day has been drawn on, so the count shows.
    mockUseTrialRemaining.mockReturnValue(trialRead(5, false));

    renderStack([TRIAL_NOTICE]);

    expect(countElement()).toHaveTextContent('5 messages left in your free preview today.');
  });

  it('says nothing on the publisher’s verdict even while holding a count that looks spent', () => {
    mockUseTrialRemaining.mockReturnValue(trialRead(1, true));

    renderStack([TRIAL_NOTICE]);

    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.budgetMessage(TRIAL_REMAINING_MESSAGE_ID))
    ).not.toBeInTheDocument();
  });

  it('asks for no count on a composer with no trial allowance', () => {
    renderStack([TRIAL_NOTICE], false);

    expect(mockUseTrialRemaining).toHaveBeenCalledWith({ enabled: false, runInFlight: false });
  });

  it('reports the live run the count must re-read after', () => {
    renderStack([TRIAL_NOTICE], true, true);

    expect(mockUseTrialRemaining).toHaveBeenCalledWith({ enabled: true, runInFlight: true });
  });

  it('hands its class to the stack', () => {
    render(
      <ComposerMessages notices={[TRIAL_NOTICE]} isTrial runInFlight={false} className="mt-2" />
    );

    expect(screen.getByTestId(TEST_IDS.budgetMessages)).toHaveClass('mt-2');
  });

  describe('while a trial refusal disables the composer', () => {
    beforeEach(() => {
      useTrialChatStore.getState().setRateLimited(true);
      mockUseTrialRemaining.mockReturnValue(trialRead(0, false));
    });

    it('drops the exhausted count', () => {
      renderStack([BLOCKING_NOTICE, TRIAL_NOTICE]);

      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.budgetMessage(TRIAL_REMAINING_MESSAGE_ID))
      ).not.toBeInTheDocument();
    });

    it('drops the free-preview notice', () => {
      renderStack([BLOCKING_NOTICE, TRIAL_NOTICE]);

      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.budgetMessage('trial_preview_pays'))
      ).not.toBeInTheDocument();
    });

    it('keeps the other notices', () => {
      renderStack([BLOCKING_NOTICE, TRIAL_NOTICE]);

      expect(
        screen.getByTestId(TEST_ID_BUILDERS.budgetMessage('trial_message_cap_exceeded'))
      ).toBeInTheDocument();
    });

    it('leaves a composer with no trial allowance as it was given', () => {
      mockUseTrialRemaining.mockReturnValue(trialRead(undefined, true));

      renderStack([TRIAL_NOTICE], false);

      expect(
        screen.getByTestId(TEST_ID_BUILDERS.budgetMessage('trial_preview_pays'))
      ).toBeInTheDocument();
    });
  });

  it('states the exhausted count again once the refusal is lifted', () => {
    mockUseTrialRemaining.mockReturnValue(trialRead(0, false));
    useTrialChatStore.getState().setRateLimited(true);
    const { rerender } = render(
      <ComposerMessages notices={[TRIAL_NOTICE]} isTrial runInFlight={false} />
    );

    act(() => {
      useTrialChatStore.getState().setRateLimited(false);
    });
    rerender(<ComposerMessages notices={[TRIAL_NOTICE]} isTrial runInFlight={false} />);

    expect(countElement()).toHaveTextContent('No messages left in your free preview today.');
  });

  it('states the exhausted count while no trial refusal disables the composer', () => {
    mockUseTrialRemaining.mockReturnValue(trialRead(0, false));

    renderStack([TRIAL_NOTICE]);

    expect(countElement()).toBeInTheDocument();
  });
});
