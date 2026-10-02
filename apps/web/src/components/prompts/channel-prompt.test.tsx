import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/hooks/growth/use-acquisition-source', () => ({
  useAcquisitionSource: vi.fn(),
  useSelfReport: vi.fn(),
}));

import { ChannelPrompt, ChannelPromptRail } from '@/components/prompts/channel-prompt';
import { useAcquisitionSource, useSelfReport } from '@/hooks/growth/use-acquisition-source';
import { useRightPane } from '@/stores/ui/right-pane';
import { useUIStore } from '@/stores/ui/ui';
import type { GrowthSelfReportContext } from '@hushbox/shared';

const mockedAcquisitionSource = vi.mocked(useAcquisitionSource);
const mockedSelfReport = vi.mocked(useSelfReport);
const submit = vi.fn();

function setDuePrompt(duePrompt: GrowthSelfReportContext | null): void {
  mockedAcquisitionSource.mockReturnValue({ data: { duePrompt } } as ReturnType<
    typeof useAcquisitionSource
  >);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSelfReport.mockReturnValue({ submit, isSubmitting: false });
  useUIStore.setState({ sidebarOpen: false });
  useRightPane.setState({ active: null });
  setDuePrompt('post_signup');
});

describe('ChannelPrompt', () => {
  it('renders nothing when the server says no prompt is due', () => {
    setDuePrompt(null);

    const { container } = render(<ChannelPrompt />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before the server has answered at all', () => {
    mockedAcquisitionSource.mockReturnValue({ data: undefined } as ReturnType<
      typeof useAcquisitionSource
    >);

    const { container } = render(<ChannelPrompt />);

    expect(container).toBeEmptyDOMElement();
  });

  it('asks the post-signup question when that is what is due', () => {
    render(<ChannelPrompt />);

    expect(
      screen.getByRole('heading', { name: 'Where did you hear about HushBox?' })
    ).toBeInTheDocument();
  });

  it('thanks the payer when the first-payment question is what is due', () => {
    setDuePrompt('first_payment');

    render(<ChannelPrompt />);

    expect(
      screen.getByRole('heading', {
        name: 'Thanks for topping up. Where did you first hear about us?',
      })
    ).toBeInTheDocument();
  });

  it('says the question is optional', () => {
    render(<ChannelPrompt />);

    expect(screen.getByText('Optional.')).toBeInTheDocument();
  });

  it('offers the eight closed-set answers', () => {
    render(<ChannelPrompt />);

    const chips = screen.getAllByRole('button', { pressed: false });
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Podcast',
      'Search',
      'Social',
      'Friend or colleague',
      'Ad',
      'Newsletter',
      'Article or review',
      'Other',
    ]);
  });

  it('offers no way to type an answer', () => {
    const { container } = render(<ChannelPrompt />);

    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('waits for Done rather than submitting on the chip tap', async () => {
    render(<ChannelPrompt />);

    await userEvent.click(screen.getByRole('button', { name: 'Podcast' }));

    expect(submit).not.toHaveBeenCalled();
  });

  it('sends the chosen channel and the context it was asked in', async () => {
    render(<ChannelPrompt />);

    await userEvent.click(screen.getByRole('button', { name: 'Friend or colleague' }));
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(submit).toHaveBeenCalledWith({
      action: 'answer',
      channel: 'friend',
      context: 'post_signup',
    });
  });

  it('refuses Done until an answer is chosen', () => {
    render(<ChannelPrompt />);

    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
  });

  it('sends a skip for the context when the user skips', async () => {
    setDuePrompt('first_payment');
    render(<ChannelPrompt />);

    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));

    expect(submit).toHaveBeenCalledWith({ action: 'skip', context: 'first_payment' });
  });

  it('sends a skip when the user closes the card instead of answering', async () => {
    render(<ChannelPrompt />);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss this question' }));

    expect(submit).toHaveBeenCalledWith({ action: 'skip', context: 'post_signup' });
  });
});

describe('ChannelPromptRail', () => {
  it('renders nothing when the server says no prompt is due', () => {
    setDuePrompt(null);

    const { container } = render(<ChannelPromptRail />);

    expect(container).toBeEmptyDOMElement();
  });

  it('offers a labelled control that says what is waiting in the sidebar', () => {
    render(<ChannelPromptRail />);

    expect(
      screen.getByRole('button', { name: 'Where did you hear about HushBox?' })
    ).toBeInTheDocument();
  });

  it('expands the sidebar', async () => {
    render(<ChannelPromptRail />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Where did you hear about HushBox?' })
    );

    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });

  it('leaves the question unanswered when pressed', async () => {
    render(<ChannelPromptRail />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Where did you hear about HushBox?' })
    );

    expect(submit).not.toHaveBeenCalled();
  });

  it('closes a docked pane when pressed over one', async () => {
    useRightPane.setState({ active: 'members' });
    render(<ChannelPromptRail />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Where did you hear about HushBox?' })
    );

    expect(useRightPane.getState().active).toBeNull();
  });

  it('keeps a saved open sidebar open when pressed over a pane', async () => {
    useUIStore.setState({ sidebarOpen: true });
    useRightPane.setState({ active: 'members' });
    render(<ChannelPromptRail />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Where did you hear about HushBox?' })
    );

    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });
});
