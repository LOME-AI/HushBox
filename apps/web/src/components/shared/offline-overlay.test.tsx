import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { OfflineOverlay } from './offline-overlay';
import { useNetworkStore } from '@/stores/network';

describe('OfflineOverlay', () => {
  beforeEach(() => {
    useNetworkStore.setState({ isOffline: false });
  });

  it('does not render when online', () => {
    render(<OfflineOverlay />);

    expect(screen.queryByTestId('offline-overlay')).not.toBeInTheDocument();
  });

  it('renders when offline', () => {
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    expect(screen.getByTestId('offline-overlay')).toBeInTheDocument();
  });

  it('displays offline title', () => {
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    expect(screen.getByTestId('offline-overlay-title')).toHaveTextContent("You're Offline");
  });

  it('displays reconnection message', () => {
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    expect(screen.getByTestId('offline-overlay-description')).toHaveTextContent(
      'reconnect automatically'
    );
  });

  it('auto-dismisses when network returns', () => {
    useNetworkStore.setState({ isOffline: true });

    const { rerender } = render(<OfflineOverlay />);
    expect(screen.getByTestId('offline-overlay')).toBeInTheDocument();

    act(() => {
      useNetworkStore.setState({ isOffline: false });
    });
    rerender(<OfflineOverlay />);

    expect(screen.queryByTestId('offline-overlay')).not.toBeInTheDocument();
  });
});
