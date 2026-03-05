import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpgradeRequiredModal } from './upgrade-required-modal';
import { useAppVersionStore } from '@/stores/app-version';

describe('UpgradeRequiredModal', () => {
  beforeEach(() => {
    useAppVersionStore.setState({ upgradeRequired: false });
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

  it('calls window.location.reload when refresh is clicked', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    const reloadMock = vi.fn();
    Object.defineProperty(globalThis, 'location', {
      value: { reload: reloadMock },
      writable: true,
    });
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId('upgrade-required-refresh'));

    expect(reloadMock).toHaveBeenCalledOnce();
  });

  it('does not show close button (non-dismissable)', () => {
    useAppVersionStore.setState({ upgradeRequired: true });

    render(<UpgradeRequiredModal />);

    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });
});
