import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MARKETING_BASE_URL, TEST_IDS } from '@hushbox/shared';
import { MANAGE_BALANCE_ONLINE_LABEL } from '@hushbox/shared/billing-portal';

const { mockLoginLinkPost, mockFetchJson, mockOpenExternalUrl } = vi.hoisted(() => ({
  mockLoginLinkPost: vi.fn(),
  mockFetchJson: vi.fn(),
  mockOpenExternalUrl: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock('@/lib/api-client.js', () => ({
  client: {
    billing: {
      'login-link': { $post: mockLoginLinkPost },
    },
  },
  fetchJson: mockFetchJson,
}));

vi.mock('@/capacitor/browser', () => ({
  openExternalUrl: mockOpenExternalUrl,
}));

import { ManageOnlineButton } from './manage-online-button';

const BUTTON_SOURCES = import.meta.glob<string>('./manage-online-button.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('ManageOnlineButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoginLinkPost.mockReturnValue(Promise.resolve(new Response()));
  });

  it('renders with "Manage Balance Online" text', () => {
    render(<ManageOnlineButton />);

    expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).toHaveTextContent(
      'Manage Balance Online'
    );
  });

  // The billing portal's expired state tells the user to tap this button by name, so the
  // name has one source, and a copy typed here could drift from the one the portal prints.
  it('takes its label from the shared constant rather than a copy of the words', () => {
    const sources = Object.values(BUTTON_SOURCES);

    expect(sources).toHaveLength(1);
    expect(sources[0]).not.toContain(MANAGE_BALANCE_ONLINE_LABEL);
  });

  it('draws as a block button, whose label wraps inside its fill', () => {
    render(<ManageOnlineButton />);

    expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).toHaveAttribute('data-block');
  });

  it('opens the token-exchange route at the marketing origin carrying the minted token', async () => {
    const user = userEvent.setup();
    mockFetchJson.mockResolvedValueOnce({ token: 'test-token-123' });

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId(TEST_IDS.manageOnlineButton));

    await waitFor(() => {
      expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1);
    });
    const opened = new URL(mockOpenExternalUrl.mock.calls[0]![0]);
    expect(opened.origin).toBe(MARKETING_BASE_URL);
    expect(opened.pathname).toBe('/billing-portal');
    expect(opened.searchParams.get('token')).toBe('test-token-123');
  });

  it('sends an Idempotency-Key with the token request', async () => {
    const user = userEvent.setup();
    mockFetchJson.mockResolvedValueOnce({ token: 'test-token-123' });

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId(TEST_IDS.manageOnlineButton));

    await waitFor(() => {
      expect(mockLoginLinkPost).toHaveBeenCalledWith(
        {},
        { headers: { 'Idempotency-Key': expect.any(String) } }
      );
    });
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

    await user.click(screen.getByTestId(TEST_IDS.manageOnlineButton));

    expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).toBeDisabled();

    resolveToken({ token: 'tok' });

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).not.toBeDisabled();
    });
  });

  it('re-enables button after error', async () => {
    const user = userEvent.setup();
    mockFetchJson.mockRejectedValueOnce(new Error('Network error'));

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId(TEST_IDS.manageOnlineButton));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).not.toBeDisabled();
    });
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it('does not open browser when the token call fails', async () => {
    const user = userEvent.setup();
    mockFetchJson.mockRejectedValueOnce(new Error('Auth failed'));

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId(TEST_IDS.manageOnlineButton));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).not.toBeDisabled();
    });
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });
});
