import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockFetchJson, mockOpenExternalUrl } = vi.hoisted(() => ({
  mockFetchJson: vi.fn(),
  mockOpenExternalUrl: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  client: {
    api: {
      billing: {
        'login-link': {
          $post: vi.fn(),
        },
      },
    },
  },
  fetchJson: mockFetchJson,
}));

vi.mock('@/capacitor/browser', () => ({
  openExternalUrl: mockOpenExternalUrl,
}));

import { ManageOnlineButton } from './manage-online-button';

describe('ManageOnlineButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with "Manage Balance Online" text', () => {
    render(<ManageOnlineButton />);

    expect(screen.getByTestId('manage-online-button')).toHaveTextContent('Manage Balance Online');
  });

  it('calls login-link API and opens external URL on click', async () => {
    const user = userEvent.setup();
    mockFetchJson.mockResolvedValueOnce({ token: 'test-token-123' });

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId('manage-online-button'));

    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalled();
    });
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(
      'https://hushbox.ai/billing?token=test-token-123'
    );
  });

  it('disables button while loading', async () => {
    const user = userEvent.setup();
    let resolveToken!: (value: { token: string }) => void;
    mockFetchJson.mockReturnValueOnce(
      new Promise<{ token: string }>((resolve) => {
        resolveToken = resolve;
      })
    );

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId('manage-online-button'));

    expect(screen.getByTestId('manage-online-button')).toBeDisabled();

    resolveToken({ token: 'tok' });

    await waitFor(() => {
      expect(screen.getByTestId('manage-online-button')).not.toBeDisabled();
    });
  });

  it('re-enables button after error', async () => {
    const user = userEvent.setup();
    mockFetchJson.mockRejectedValueOnce(new Error('Network error'));

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId('manage-online-button'));

    await waitFor(() => {
      expect(screen.getByTestId('manage-online-button')).not.toBeDisabled();
    });
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it('does not open browser when API call fails', async () => {
    const user = userEvent.setup();
    mockFetchJson.mockRejectedValueOnce(new Error('Auth failed'));

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId('manage-online-button'));

    await waitFor(() => {
      expect(screen.getByTestId('manage-online-button')).not.toBeDisabled();
    });
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });
});
