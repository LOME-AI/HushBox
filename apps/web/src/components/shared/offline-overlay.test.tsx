import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { useNetworkStore } from '@/stores/network';
import { OfflineOverlay } from './offline-overlay';

describe('OfflineOverlay', () => {
  beforeEach(() => {
    useNetworkStore.setState({ isOffline: false });
  });

  it('does not render when online', () => {
    render(<OfflineOverlay />);

    expect(screen.queryByTestId(TEST_IDS.offlineOverlay)).not.toBeInTheDocument();
  });

  it('renders when offline', () => {
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    expect(screen.getByTestId(TEST_IDS.offlineOverlay)).toBeInTheDocument();
  });

  it('displays offline title', () => {
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    expect(screen.getByTestId(TEST_IDS.offlineOverlayTitle)).toHaveTextContent("You're Offline");
  });

  it('displays reconnection message', () => {
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    expect(screen.getByTestId(TEST_IDS.offlineOverlayDescription)).toHaveTextContent(
      'reconnect automatically'
    );
  });

  it('auto-dismisses when network returns', () => {
    useNetworkStore.setState({ isOffline: true });

    const { rerender } = render(<OfflineOverlay />);
    expect(screen.getByTestId(TEST_IDS.offlineOverlay)).toBeInTheDocument();

    act(() => {
      useNetworkStore.setState({ isOffline: false });
    });
    rerender(<OfflineOverlay />);

    expect(screen.queryByTestId(TEST_IDS.offlineOverlay)).not.toBeInTheDocument();
  });
});
