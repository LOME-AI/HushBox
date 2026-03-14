import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpgradeRequiredModal } from './upgrade-required-modal';
import { useAppVersionStore } from '@/stores/app-version';

const { mockIsNative, mockCheckForUpdate, mockApplyUpdate } = vi.hoisted(() => ({
  mockIsNative: vi.fn(() => false),
  mockCheckForUpdate: vi.fn(),
  mockApplyUpdate: vi.fn(),
}));

vi.mock('@/capacitor/platform', () => ({
  isNative: mockIsNative,
}));

vi.mock('@/capacitor/live-update', () => ({
  checkForUpdate: mockCheckForUpdate,
  applyUpdate: mockApplyUpdate,
}));

describe('UpgradeRequiredModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppVersionStore.setState({ upgradeRequired: false });
    mockIsNative.mockReturnValue(false);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    mockApplyUpdate.mockResolvedValue(undefined);
  });

  it('does not render when upgradeRequired is false', () => {
    render(<UpgradeRequiredModal />);

    expect(screen.queryByTestId('upgrade-required-modal')).not.toBeInTheDocument();
  });

  it('renders when upgradeRequired is true', () => {
    useAppVersionStore.setState({ upgradeRequired: true });

    render(<UpgradeRequiredModal />);

    expect(screen.getByTestId('upgrade-required-modal')).toBeInTheDocument();
  });

  it('displays update required title', () => {
    useAppVersionStore.setState({ upgradeRequired: true });

    render(<UpgradeRequiredModal />);

    expect(screen.getByTestId('upgrade-required-title')).toHaveTextContent('Update Required');
  });

  it('displays description about new version', () => {
    useAppVersionStore.setState({ upgradeRequired: true });

    render(<UpgradeRequiredModal />);

    expect(screen.getByTestId('upgrade-required-description')).toHaveTextContent(
      'A new version is available'
    );
  });

  it('renders a refresh button', () => {
    useAppVersionStore.setState({ upgradeRequired: true });

    render(<UpgradeRequiredModal />);

    expect(screen.getByTestId('upgrade-required-refresh')).toBeInTheDocument();
    expect(screen.getByTestId('upgrade-required-refresh')).toHaveTextContent('Refresh');
  });

  it('calls window.location.reload on web when refresh is clicked', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(false);
    const reloadMock = vi.fn();
    Object.defineProperty(globalThis, 'location', {
      value: { reload: reloadMock },
      writable: true,
    });
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId('upgrade-required-refresh'));

    expect(reloadMock).toHaveBeenCalledOnce();
    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });

  it('does not call location.reload on native', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });
    const reloadMock = vi.fn();
    Object.defineProperty(globalThis, 'location', {
      value: { reload: reloadMock },
      writable: true,
    });
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId('upgrade-required-refresh'));

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('calls checkForUpdate on native when refresh is clicked', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId('upgrade-required-refresh'));

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
  });

  it('calls applyUpdate with server version when update is available', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: true, serverVersion: 'v2' });
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId('upgrade-required-refresh'));

    await vi.waitFor(() => {
      expect(mockApplyUpdate).toHaveBeenCalledWith('v2');
    });
  });

  it('does not call applyUpdate when no update is available', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId('upgrade-required-refresh'));

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
    expect(mockApplyUpdate).not.toHaveBeenCalled();
  });

  it('disables button while updating on native', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    // Never-resolving promise to keep isUpdating=true
    mockCheckForUpdate.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId('upgrade-required-refresh'));

    await vi.waitFor(() => {
      expect(screen.getByTestId('upgrade-required-refresh')).toBeDisabled();
    });
  });

  it('shows updating text while in progress on native', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId('upgrade-required-refresh'));

    await vi.waitFor(() => {
      expect(screen.getByTestId('upgrade-required-refresh')).toHaveTextContent('Updating...');
    });
  });

  it('re-enables button after update attempt completes', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: true, serverVersion: 'v2' });
    // applyUpdate resolves without destroying JS (simulating failure path)
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    mockApplyUpdate.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId('upgrade-required-refresh'));

    await vi.waitFor(() => {
      expect(screen.getByTestId('upgrade-required-refresh')).not.toBeDisabled();
    });
  });

  it('does not show close button (non-dismissable)', () => {
    useAppVersionStore.setState({ upgradeRequired: true });

    render(<UpgradeRequiredModal />);

    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });
});
