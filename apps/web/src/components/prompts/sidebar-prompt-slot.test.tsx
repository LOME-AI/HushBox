import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/notifications/use-enable-prompt', () => ({ useEnablePrompt: vi.fn() }));
vi.mock('@/hooks/growth/use-acquisition-source', () => ({
  useAcquisitionSource: vi.fn(),
  useSelfReport: vi.fn(),
}));
vi.mock('@/stores/ui/ui', () => ({ useUIStore: vi.fn(() => vi.fn()) }));

import { SidebarPromptSlot } from '@/components/prompts/sidebar-prompt-slot';
import { useEnablePrompt } from '@/hooks/notifications/use-enable-prompt';
import { useAcquisitionSource, useSelfReport } from '@/hooks/growth/use-acquisition-source';

const mockedEnablePrompt = vi.mocked(useEnablePrompt);
const mockedAcquisitionSource = vi.mocked(useAcquisitionSource);
const mockedSelfReport = vi.mocked(useSelfReport);

function setEligibility(options: {
  readonly notifications: boolean;
  readonly channel: boolean;
}): void {
  mockedEnablePrompt.mockReturnValue({
    isVisible: options.notifications,
    isEnabling: false,
    enable: vi.fn(),
    dismiss: vi.fn(),
  });
  mockedAcquisitionSource.mockReturnValue({
    data: options.channel ? { duePrompt: 'post_signup' } : { duePrompt: null },
  } as ReturnType<typeof useAcquisitionSource>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSelfReport.mockReturnValue({ submit: vi.fn(), isSubmitting: false });
});

describe('SidebarPromptSlot', () => {
  it('renders nothing when no prompt is due', () => {
    setEligibility({ notifications: false, channel: false });

    const { container } = render(<SidebarPromptSlot collapsed={false} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the one prompt that is due', () => {
    setEligibility({ notifications: false, channel: true });

    render(<SidebarPromptSlot collapsed={false} />);

    expect(
      screen.getByRole('heading', { name: 'Where did you hear about HushBox?' })
    ).toBeInTheDocument();
  });

  it('shows exactly one card when two prompts are eligible at once', () => {
    setEligibility({ notifications: true, channel: true });

    render(<SidebarPromptSlot collapsed={false} />);

    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('shows the higher-priority prompt when two are eligible at once', () => {
    setEligibility({ notifications: true, channel: true });

    render(<SidebarPromptSlot collapsed={false} />);

    expect(screen.getByRole('heading', { name: 'Turn on notifications' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Where did you hear about HushBox?' })
    ).not.toBeInTheDocument();
  });

  it('shows the due prompt as a rail stand-in when the sidebar is collapsed', () => {
    setEligibility({ notifications: false, channel: true });

    render(<SidebarPromptSlot collapsed />);

    expect(
      screen.getByRole('button', { name: 'Where did you hear about HushBox?' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
