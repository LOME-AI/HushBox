import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnablePrompt } from '@/hooks/notifications/use-enable-prompt';
import { useRightPane } from '@/stores/ui/right-pane';
import { useUIStore } from '@/stores/ui/ui';
import { NotificationEnablePromptRail } from './enable-prompt-rail';

vi.mock('@/hooks/notifications/use-enable-prompt', () => ({
  useEnablePrompt: vi.fn(),
}));

const mockUseEnablePrompt = vi.mocked(useEnablePrompt);
const enable = vi.fn();
const dismiss = vi.fn();

function offerDue(isVisible: boolean): void {
  mockUseEnablePrompt.mockReturnValue({ isVisible, isEnabling: false, enable, dismiss });
}

describe('NotificationEnablePromptRail', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: false });
    useRightPane.setState({ active: null });
    enable.mockClear();
    dismiss.mockClear();
    offerDue(true);
  });

  it('draws nothing when the offer is not due', () => {
    offerDue(false);

    render(<NotificationEnablePromptRail />);

    expect(screen.queryByRole('button', { name: 'Turn on notifications' })).toBeNull();
  });

  it('opens the sidebar, where the card waits', async () => {
    const user = userEvent.setup();
    render(<NotificationEnablePromptRail />);

    await user.click(screen.getByRole('button', { name: 'Turn on notifications' }));

    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });

  it('leaves the offer unanswered when pressed', async () => {
    const user = userEvent.setup();
    render(<NotificationEnablePromptRail />);

    await user.click(screen.getByRole('button', { name: 'Turn on notifications' }));

    expect(enable).not.toHaveBeenCalled();
  });

  it('closes a docked pane when pressed over one', async () => {
    const user = userEvent.setup();
    useRightPane.setState({ active: 'members' });
    render(<NotificationEnablePromptRail />);

    await user.click(screen.getByRole('button', { name: 'Turn on notifications' }));

    expect(useRightPane.getState().active).toBeNull();
  });

  it('keeps a saved open sidebar open when pressed over a pane', async () => {
    const user = userEvent.setup();
    useUIStore.setState({ sidebarOpen: true });
    useRightPane.setState({ active: 'members' });
    render(<NotificationEnablePromptRail />);

    await user.click(screen.getByRole('button', { name: 'Turn on notifications' }));

    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });
});
