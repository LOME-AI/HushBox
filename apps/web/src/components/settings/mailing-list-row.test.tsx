import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { renderWithProviders } from '@/test-utils/render';

vi.mock('@/lib/api-client', () => ({
  client: {
    newsletter: { me: { $get: vi.fn(), $put: vi.fn() } },
  },
  fetchJson: vi.fn(),
}));

vi.mock('@/hooks/auth/use-stable-session', () => ({
  useStableSession: vi.fn(),
}));

vi.mock('@/capacitor/platform', () => ({
  isNative: (): boolean => false,
}));

import { client, fetchJson } from '@/lib/api-client';
import { useStableSession } from '@/hooks/auth/use-stable-session';
import { MailingListRow } from './mailing-list-row';

const mockedClient = vi.mocked(client, true);
const mockedFetchJson = vi.mocked(fetchJson);
const mockedUseStableSession = vi.mocked(useStableSession);

function stubClientCalls(): void {
  vi.mocked(mockedClient.newsletter.me.$get).mockReturnValue(
    Promise.resolve(new Response()) as unknown as ReturnType<typeof mockedClient.newsletter.me.$get>
  );
  vi.mocked(mockedClient.newsletter.me.$put).mockReturnValue(
    Promise.resolve(new Response()) as unknown as ReturnType<typeof mockedClient.newsletter.me.$put>
  );
}

const ROW_SOURCES = import.meta.glob<string>('./mailing-list-row.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const LOAD_ERROR = 'Could not load this setting. Refresh to try again.';

/** `AsyncRegion`'s pending placeholder, a busy named group, drawn while the setting loads. */
function findLoadingPlaceholder(): Promise<HTMLElement> {
  return screen.findByRole('group', { name: 'Mailing list setting', busy: true });
}

const DESCRIPTION_COPY =
  'A few letters a year to your account email. No tracking. Separate from account and billing emails.';

describe('MailingListRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubClientCalls();
    mockedUseStableSession.mockReturnValue({
      session: null,
      isAuthenticated: true,
      isStable: true,
      isPending: false,
    });
  });

  it('renders the title and the exact description copy', async () => {
    mockedFetchJson.mockResolvedValue({ subscribed: false });
    renderWithProviders(<MailingListRow />);

    expect(screen.getByText('Mailing list')).toBeInTheDocument();
    expect(screen.getByText(DESCRIPTION_COPY)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.settingsMailingListToggle)).toBeInTheDocument();
    });
  });

  it('shows the loading placeholder instead of the toggle while the settings load', async () => {
    mockedFetchJson.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<MailingListRow />);

    expect(await findLoadingPlaceholder()).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.settingsMailingListToggle)).not.toBeInTheDocument();
  });

  it('draws no pulse of its own while loading', () => {
    const sources = Object.values(ROW_SOURCES);

    expect(sources).toHaveLength(1);
    expect(sources[0]).not.toContain('animate-pulse');
  });

  it('names the switch by the row title', async () => {
    mockedFetchJson.mockResolvedValue({ subscribed: false });
    renderWithProviders(<MailingListRow />);

    expect(await screen.findByRole('switch', { name: 'Mailing list' })).toHaveAttribute(
      'data-testid',
      TEST_IDS.settingsMailingListToggle
    );
  });

  it('describes the switch with the row description', async () => {
    mockedFetchJson.mockResolvedValue({ subscribed: false });
    renderWithProviders(<MailingListRow />);

    const toggle = await screen.findByRole('switch', { name: 'Mailing list' });
    expect(toggle).toHaveAccessibleDescription(`${DESCRIPTION_COPY} Privacy Policy`);
  });

  it('shows an error message instead of the toggle when the settings fail to load', async () => {
    mockedFetchJson.mockRejectedValue(new Error('boom'));
    renderWithProviders(<MailingListRow />);

    await waitFor(() => {
      expect(screen.getByText('Could not load this setting. Refresh to try again.')).toBeVisible();
    });
    expect(screen.queryByTestId(TEST_IDS.settingsMailingListToggle)).not.toBeInTheDocument();
  });

  it('keeps the load error out of the text block so the description keeps its width', async () => {
    mockedFetchJson.mockRejectedValue(new Error('boom'));
    renderWithProviders(<MailingListRow />);

    const error = await screen.findByText(LOAD_ERROR);
    const description = screen.getByText(DESCRIPTION_COPY);
    expect(description.parentElement).not.toContainElement(error);
  });

  it('puts the load error after the description, on a line of its own under the text', async () => {
    mockedFetchJson.mockRejectedValue(new Error('boom'));
    renderWithProviders(<MailingListRow />);

    const error = await screen.findByText(LOAD_ERROR);
    const description = screen.getByText(DESCRIPTION_COPY);
    expect(
      description.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(error.closest('[data-settings-row]')).toContainElement(description);
  });

  it('renders the title, text and control as one settings row', async () => {
    mockedFetchJson.mockResolvedValue({ subscribed: false });
    renderWithProviders(<MailingListRow />);

    const toggle = await screen.findByTestId(TEST_IDS.settingsMailingListToggle);
    const row = toggle.closest('[data-settings-row]');
    expect(row).toContainElement(screen.getByText('Mailing list'));
    expect(row).toContainElement(screen.getByText(DESCRIPTION_COPY));
  });

  it('keeps the Privacy Policy link text on one line', async () => {
    mockedFetchJson.mockResolvedValue({ subscribed: false });
    renderWithProviders(<MailingListRow />);

    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveClass('whitespace-nowrap');
    await screen.findByTestId(TEST_IDS.settingsMailingListToggle);
  });

  it('reflects a subscribed account as a checked switch', async () => {
    mockedFetchJson.mockResolvedValue({ subscribed: true });
    renderWithProviders(<MailingListRow />);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.settingsMailingListToggle)).toBeChecked();
    });
  });

  it('sends the flipped value on toggle and disables the switch while pending', async () => {
    mockedFetchJson.mockResolvedValueOnce({ subscribed: false });
    let resolvePut: (value: unknown) => void = () => {};
    mockedFetchJson.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePut = resolve;
        })
    );
    const user = userEvent.setup();
    renderWithProviders(<MailingListRow />);

    const toggle = await screen.findByTestId(TEST_IDS.settingsMailingListToggle);
    await user.click(toggle);

    expect(mockedClient.newsletter.me.$put).toHaveBeenCalledWith({ json: { subscribed: true } });
    expect(toggle).toBeDisabled();

    resolvePut({ subscribed: true });
    await waitFor(() => {
      expect(toggle).toBeEnabled();
    });
    expect(toggle).toBeChecked();
  });

  it('settles to unchecked without an error when the server answers false to an optimistic subscribe', async () => {
    // Complaint-suppressed subscriber: the server refuses the resubscribe and
    // answers {subscribed: false}. Deliberate product behavior, not an error.
    mockedFetchJson.mockResolvedValueOnce({ subscribed: false });
    mockedFetchJson.mockResolvedValueOnce({ subscribed: false });
    const user = userEvent.setup();
    renderWithProviders(<MailingListRow />);

    const toggle = await screen.findByTestId(TEST_IDS.settingsMailingListToggle);
    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toBeEnabled();
    });
    expect(toggle).not.toBeChecked();
    expect(
      screen.queryByText('Could not load this setting. Refresh to try again.')
    ).not.toBeInTheDocument();
  });

  describe.each([
    {
      state: 'loading',
      arrange: (): void => {
        mockedFetchJson.mockImplementation(() => new Promise(() => {}));
      },
      settle: async (): Promise<void> => {
        await findLoadingPlaceholder();
      },
    },
    {
      state: 'error',
      arrange: (): void => {
        mockedFetchJson.mockRejectedValue(new Error('boom'));
      },
      settle: async (): Promise<void> => {
        await screen.findByText('Could not load this setting. Refresh to try again.');
      },
    },
    {
      state: 'loaded',
      arrange: (): void => {
        mockedFetchJson.mockResolvedValue({ subscribed: false });
      },
      settle: async (): Promise<void> => {
        await screen.findByTestId(TEST_IDS.settingsMailingListToggle);
      },
    },
  ])('in the $state state', ({ arrange, settle }) => {
    it('shows the unchanged description copy', async () => {
      arrange();
      renderWithProviders(<MailingListRow />);
      await settle();

      expect(screen.getByText(DESCRIPTION_COPY)).toBeInTheDocument();
    });

    it('links to the Privacy Policy on the marketing site', async () => {
      arrange();
      renderWithProviders(<MailingListRow />);
      await settle();

      expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
        'href',
        '/privacy'
      );
    });
  });

  it('restores the previous switch state when the update fails', async () => {
    mockedFetchJson.mockResolvedValueOnce({ subscribed: false });
    mockedFetchJson.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    renderWithProviders(<MailingListRow />);

    const toggle = await screen.findByTestId(TEST_IDS.settingsMailingListToggle);
    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toBeEnabled();
    });
    expect(toggle).not.toBeChecked();
  });
});
