import * as React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test-utils/render';

vi.mock('@/lib/api-client', () => ({
  client: { notifications: { preferences: { $get: vi.fn(), $put: vi.fn() } } },
  fetchJson: vi.fn(),
}));

vi.mock('@/hooks/auth/use-stable-session', () => ({
  useStableSession: vi.fn(),
}));

vi.mock('@/lib/notification-channel', () => ({
  notificationChannel: {
    getPermissionState: vi.fn(),
    getLastRegistrationOutcome: vi.fn(),
    requestPermissionAndRegister: vi.fn(),
    ensureRegistered: vi.fn(),
    unregister: vi.fn(),
  },
}));

// Web Audio does not exist in the test DOM; the unlock is what the toggle owes
// the store, so it is observed rather than performed.
vi.mock('@/lib/notification-activity/sound', () => ({
  primeNotificationSound: vi.fn(),
  playNotificationSound: vi.fn(),
}));

// Radix Select drives its listbox through pointer-capture APIs the test DOM
// lacks, so the select field is swapped for a native <select> that keeps its
// label, value, options, `disabled` and `onValueChange` observable.
vi.mock('@hushbox/ui/field', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui/field')>();

  function SelectFieldMock({
    label,
    value,
    onValueChange,
    options,
    disabled,
  }: Readonly<{
    label: string;
    value: string;
    onValueChange: (next: string) => void;
    options: readonly { value: string; label: string }[];
    disabled?: boolean;
  }>): React.JSX.Element {
    const id = React.useId();
    return (
      <div>
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            onValueChange(event.target.value);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return { ...actual, SelectField: SelectFieldMock };
});

import { client, fetchJson } from '@/lib/api-client';
import { useStableSession } from '@/hooks/auth/use-stable-session';
import { notificationChannel } from '@/lib/notification-channel';
import { primeNotificationSound } from '@/lib/notification-activity/sound';
import { useNotificationActivityStore } from '@/stores/activity/notification';
import { NotificationsSettings } from './notifications-settings';

const mockedClient = vi.mocked(client, true);
const mockedFetchJson = vi.mocked(fetchJson);
const mockedUseStableSession = vi.mocked(useStableSession);
const mockedChannel = vi.mocked(notificationChannel);
const mockedPrimeNotificationSound = vi.mocked(primeNotificationSound);

const DEVICE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
// A zone this machine is provably not in, whatever the runner's TZ happens to be.
const AWAY_TIMEZONE = DEVICE_TIMEZONE === 'America/New_York' ? 'Europe/London' : 'America/New_York';

const BLOCKED_MESSAGE =
  "It won't ask again. Allow notifications for HushBox in your device settings.";

const GROUP_SOURCES = import.meta.glob<string>('./notifications-settings.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The "This device" row with its control: the live region the reading is announced from. */
async function findDeviceReading(): Promise<HTMLElement> {
  const title = await screen.findByText('This device');
  const reading = title.closest<HTMLElement>('[aria-live="polite"]');
  if (reading === null) throw new Error('The device row sits outside its live region');
  return reading;
}

const PREFERENCES = {
  globalEnabled: true,
  messages: true,
  runCompletion: true,
  membership: true,
  quietHours: null,
};

function stubClientCalls(): void {
  vi.mocked(mockedClient.notifications.preferences.$get).mockReturnValue(
    Promise.resolve(new Response()) as unknown as ReturnType<
      typeof mockedClient.notifications.preferences.$get
    >
  );
  vi.mocked(mockedClient.notifications.preferences.$put).mockReturnValue(
    Promise.resolve(new Response()) as unknown as ReturnType<
      typeof mockedClient.notifications.preferences.$put
    >
  );
}

describe('NotificationsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubClientCalls();
    mockedUseStableSession.mockReturnValue({
      session: null,
      isAuthenticated: true,
      isStable: true,
      isPending: false,
    });
    mockedChannel.requestPermissionAndRegister.mockResolvedValue('granted');
    mockedChannel.getPermissionState.mockResolvedValue('granted');
    mockedChannel.getLastRegistrationOutcome.mockReturnValue('not-attempted');
    mockedChannel.ensureRegistered.mockImplementation(() => Promise.resolve());
    mockedChannel.unregister.mockImplementation(() => Promise.resolve());
  });

  it('reflects the saved preferences on every switch', async () => {
    mockedFetchJson.mockResolvedValue({ ...PREFERENCES, runCompletion: false });
    renderWithProviders(<NotificationsSettings />);

    expect(await screen.findByRole('switch', { name: 'All notifications' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'New messages' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Finished runs' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Invitations and shares' })).toBeChecked();
  });

  it('shows a skeleton while the preferences load', async () => {
    mockedFetchJson.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<NotificationsSettings />);

    expect(screen.getByRole('group', { name: 'Notification settings' })).toHaveAttribute(
      'aria-busy',
      'true'
    );
    expect(screen.queryByRole('switch', { name: 'All notifications' })).not.toBeInTheDocument();
    await findDeviceReading();
  });

  it('shows an error message when the preferences fail to load', async () => {
    mockedFetchJson.mockRejectedValue(new Error('boom'));
    renderWithProviders(<NotificationsSettings />);

    await waitFor(() => {
      expect(
        screen.getByText('Could not load these settings. Refresh to try again.')
      ).toBeVisible();
    });
    expect(screen.queryByRole('switch', { name: 'All notifications' })).not.toBeInTheDocument();
  });

  it('turns message notifications off', async () => {
    mockedFetchJson.mockResolvedValue(PREFERENCES);
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);

    await user.click(await screen.findByRole('switch', { name: 'New messages' }));

    expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
      json: { ...PREFERENCES, messages: false },
    });
  });

  it('turns finished-run notifications off', async () => {
    mockedFetchJson.mockResolvedValue(PREFERENCES);
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);

    await user.click(await screen.findByRole('switch', { name: 'Finished runs' }));

    expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
      json: { ...PREFERENCES, runCompletion: false },
    });
  });

  it('turns invitation notifications off', async () => {
    mockedFetchJson.mockResolvedValue(PREFERENCES);
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);

    await user.click(await screen.findByRole('switch', { name: 'Invitations and shares' }));

    expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
      json: { ...PREFERENCES, membership: false },
    });
  });

  it('stops delivery to this device when the account switch goes off', async () => {
    mockedFetchJson.mockResolvedValue(PREFERENCES);
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);

    await user.click(await screen.findByRole('switch', { name: 'All notifications' }));

    expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
      json: { ...PREFERENCES, globalEnabled: false },
    });
    await waitFor(() => {
      expect(mockedChannel.unregister).toHaveBeenCalledTimes(1);
    });
  });

  it('asks this device for permission when the account switch goes on', async () => {
    mockedFetchJson.mockResolvedValue({ ...PREFERENCES, globalEnabled: false });
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);

    await user.click(await screen.findByRole('switch', { name: 'All notifications' }));

    await waitFor(() => {
      expect(mockedChannel.requestPermissionAndRegister).toHaveBeenCalledTimes(1);
    });
    expect(mockedChannel.unregister).not.toHaveBeenCalled();
  });

  it('leaves this device registered when only a category changes', async () => {
    mockedFetchJson.mockResolvedValue(PREFERENCES);
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);

    await user.click(await screen.findByRole('switch', { name: 'New messages' }));

    await waitFor(() => {
      expect(mockedClient.notifications.preferences.$put).toHaveBeenCalled();
    });
    expect(mockedChannel.unregister).not.toHaveBeenCalled();
    expect(mockedChannel.requestPermissionAndRegister).not.toHaveBeenCalled();
  });

  it('keeps the account switch usable from the keyboard', async () => {
    mockedFetchJson.mockResolvedValue(PREFERENCES);
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);

    const accountSwitch = await screen.findByRole('switch', { name: 'All notifications' });
    accountSwitch.focus();
    await user.keyboard(' ');

    expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
      json: { ...PREFERENCES, globalEnabled: false },
    });
  });

  it('survives a failed device call after the preference is saved', async () => {
    mockedFetchJson.mockResolvedValueOnce(PREFERENCES);
    mockedFetchJson.mockResolvedValueOnce({ ...PREFERENCES, globalEnabled: false });
    mockedChannel.unregister.mockRejectedValue(new Error('no service worker'));
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSettings />);

    await user.click(await screen.findByRole('switch', { name: 'All notifications' }));

    await waitFor(() => {
      expect(mockedChannel.unregister).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('switch', { name: 'All notifications' })).not.toBeChecked();
  });

  describe('quiet hours', () => {
    const QUIET_HOURS = {
      startMinutes: 1320,
      endMinutes: 420,
      timezone: DEVICE_TIMEZONE,
    };

    it('hides the hour controls while quiet hours are off', async () => {
      mockedFetchJson.mockResolvedValue(PREFERENCES);
      renderWithProviders(<NotificationsSettings />);

      await screen.findByRole('switch', { name: 'Quiet hours' });
      expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Until')).not.toBeInTheDocument();
    });

    it('saves both bounds and the device timezone when quiet hours go on', async () => {
      mockedFetchJson.mockResolvedValue(PREFERENCES);
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.click(await screen.findByRole('switch', { name: 'Quiet hours' }));

      expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
        json: { ...PREFERENCES, quietHours: QUIET_HOURS },
      });
    });

    it('clears both bounds when quiet hours go off', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.click(await screen.findByRole('switch', { name: 'Quiet hours' }));

      expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
        json: { ...PREFERENCES, quietHours: null },
      });
    });

    it('shows the saved bounds on the hour controls', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      renderWithProviders(<NotificationsSettings />);

      expect(await screen.findByLabelText<HTMLSelectElement>('From')).toHaveValue('1320');
      expect(screen.getByLabelText<HTMLSelectElement>('Until')).toHaveValue('420');
    });

    it('keeps the other bound and the timezone when the start hour changes', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.selectOptions(await screen.findByLabelText('From'), '1380');

      expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
        json: { ...PREFERENCES, quietHours: { ...QUIET_HOURS, startMinutes: 1380 } },
      });
    });

    it('keeps the other bound and the timezone when the end hour changes', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.selectOptions(await screen.findByLabelText('Until'), '480');

      expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
        json: { ...PREFERENCES, quietHours: { ...QUIET_HOURS, endMinutes: 480 } },
      });
    });

    it('locks both hour controls while a save is in flight', async () => {
      // The read answers; every later call, the save among them, stays in flight.
      mockedFetchJson
        .mockResolvedValueOnce({ ...PREFERENCES, quietHours: QUIET_HOURS })
        .mockImplementation(() => new Promise(() => {}));
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.selectOptions(await screen.findByLabelText('From'), '1380');

      await waitFor(() => {
        expect(screen.getByLabelText('Until')).toBeDisabled();
      });
      expect(screen.getByLabelText('From')).toBeDisabled();
    });

    it('sends no second quiet-hours save while the first is in flight', async () => {
      // The read answers; every later call, the save among them, stays in flight.
      mockedFetchJson
        .mockResolvedValueOnce({ ...PREFERENCES, quietHours: QUIET_HOURS })
        .mockImplementation(() => new Promise(() => {}));
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.selectOptions(await screen.findByLabelText('From'), '1380');
      await user.selectOptions(screen.getByLabelText('Until'), '480');

      expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledTimes(1);
      expect(mockedClient.notifications.preferences.$put).not.toHaveBeenCalledWith({
        json: { ...PREFERENCES, quietHours: { ...QUIET_HOURS, endMinutes: 480 } },
      });
    });

    it('groups the hour controls under the quiet-hours name', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      renderWithProviders(<NotificationsSettings />);

      const group = await screen.findByRole('group', { name: 'Quiet hours' });
      expect(group).toContainElement(screen.getByLabelText('From'));
      expect(group).toContainElement(screen.getByLabelText('Until'));
    });

    it('says quiet-hours notifications are dropped rather than delayed', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      renderWithProviders(<NotificationsSettings />);

      expect(
        await screen.findByText(
          'Notifications that arrive during quiet hours are dropped, not delivered later.'
        )
      ).toBeVisible();
    });

    it('shows the timezone the hours are read in', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      renderWithProviders(<NotificationsSettings />);

      expect(await screen.findByText(`Hours are read in ${DEVICE_TIMEZONE}.`)).toBeVisible();
    });

    it('names the saved timezone when this device is somewhere else', async () => {
      mockedFetchJson.mockResolvedValue({
        ...PREFERENCES,
        quietHours: { ...QUIET_HOURS, timezone: AWAY_TIMEZONE },
      });
      renderWithProviders(<NotificationsSettings />);

      expect(await screen.findByText(`Hours are read in ${AWAY_TIMEZONE}.`)).toBeVisible();
      expect(screen.queryByText(`Hours are read in ${DEVICE_TIMEZONE}.`)).not.toBeInTheDocument();
    });

    it('offers to move the hours here when this device is somewhere else', async () => {
      mockedFetchJson.mockResolvedValue({
        ...PREFERENCES,
        quietHours: { ...QUIET_HOURS, timezone: AWAY_TIMEZONE },
      });
      renderWithProviders(<NotificationsSettings />);

      expect(
        await screen.findByText(
          `This device is in ${DEVICE_TIMEZONE}. Change a time to move quiet hours here.`
        )
      ).toBeVisible();
    });

    it('leaves out the device note when the saved timezone is this one', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      renderWithProviders(<NotificationsSettings />);

      await screen.findByLabelText('From');
      expect(screen.queryByText(/This device is in/)).not.toBeInTheDocument();
    });
  });

  describe('device permission', () => {
    beforeEach(() => {
      mockedFetchJson.mockResolvedValue(PREFERENCES);
    });

    it('confirms the device is allowed to show notifications', async () => {
      renderWithProviders(<NotificationsSettings />);

      expect(await findDeviceReading()).toHaveTextContent(/^This deviceAllowed$/);
      expect(screen.queryByRole('button', { name: 'Allow notifications' })).not.toBeInTheDocument();
    });

    it('offers to ask a device that has not been asked yet', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('default');
      renderWithProviders(<NotificationsSettings />);

      expect(await screen.findByRole('button', { name: 'Allow notifications' })).toBeVisible();
    });

    it('asks the device for permission from the This device row', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('default');
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.click(await screen.findByRole('button', { name: 'Allow notifications' }));

      expect(mockedChannel.requestPermissionAndRegister).toHaveBeenCalledTimes(1);
    });

    it('drops the offer once the device grants permission', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('default');
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.click(await screen.findByRole('button', { name: 'Allow notifications' }));

      expect(await screen.findByText('Allowed')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Allow notifications' })).not.toBeInTheDocument();
    });

    it('says a blocked device will not be asked again', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('denied');
      renderWithProviders(<NotificationsSettings />);

      expect(await screen.findByText(BLOCKED_MESSAGE)).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Allow notifications' })).not.toBeInTheDocument();
    });

    it('says a device with no push path cannot show notifications', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('unsupported');
      renderWithProviders(<NotificationsSettings />);

      expect(await screen.findByText("This device can't show push notifications.")).toBeVisible();
    });

    it('admits the device still blocks delivery after the account switch goes on', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, globalEnabled: false });
      mockedChannel.getPermissionState.mockResolvedValue('denied');
      mockedChannel.requestPermissionAndRegister.mockResolvedValue('denied');
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.click(await screen.findByRole('switch', { name: 'All notifications' }));

      await waitFor(() => {
        expect(mockedChannel.requestPermissionAndRegister).toHaveBeenCalledTimes(1);
      });
      expect(await screen.findByText(BLOCKED_MESSAGE)).toBeVisible();
    });

    it('says nothing while the device state is still unknown', () => {
      mockedChannel.getPermissionState.mockImplementation(() => new Promise(() => {}));
      renderWithProviders(<NotificationsSettings />);

      expect(screen.queryByText('This device')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Allow notifications' })).not.toBeInTheDocument();
    });

    it('keeps the last known state when the platform cannot be read', async () => {
      mockedChannel.getPermissionState.mockRejectedValue(new Error('no permission API'));
      renderWithProviders(<NotificationsSettings />);

      expect(await screen.findByRole('switch', { name: 'All notifications' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Allow notifications' })).not.toBeInTheDocument();
    });

    it('re-reads the device when a permission request throws', async () => {
      mockedChannel.getPermissionState.mockResolvedValueOnce('default');
      mockedChannel.requestPermissionAndRegister.mockRejectedValue(new Error('no service worker'));
      mockedChannel.getPermissionState.mockResolvedValue('denied');
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.click(await screen.findByRole('button', { name: 'Allow notifications' }));

      expect(await screen.findByText(BLOCKED_MESSAGE)).toBeVisible();
    });
  });

  describe('device registration', () => {
    const UNFINISHED_MESSAGE =
      'This device is allowed to show notifications, but setup did not finish. HushBox will try again next time you open the app.';
    const REFUSED_MESSAGE =
      'This device could not be set up for notifications. It may already be registered to another account.';

    beforeEach(() => {
      mockedFetchJson.mockResolvedValue(PREFERENCES);
    });

    it('says setup did not finish when this device could not be registered', async () => {
      mockedChannel.getLastRegistrationOutcome.mockReturnValue('failed-retryable');
      renderWithProviders(<NotificationsSettings />);

      expect(await screen.findByText(UNFINISHED_MESSAGE)).toBeVisible();
      expect(screen.queryByText('Allowed')).not.toBeInTheDocument();
    });

    it('keeps the unfinished reading in the live region', async () => {
      mockedChannel.getLastRegistrationOutcome.mockReturnValue('failed-retryable');
      renderWithProviders(<NotificationsSettings />);

      const reading = await screen.findByText(UNFINISHED_MESSAGE);
      expect(reading.closest('[aria-live="polite"]')).not.toBeNull();
    });

    it('registers this device again when the retry is pressed', async () => {
      mockedChannel.getLastRegistrationOutcome.mockReturnValue('failed-retryable');
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.click(await screen.findByRole('button', { name: 'Try again' }));

      expect(mockedChannel.ensureRegistered).toHaveBeenCalledTimes(1);
    });

    it('keeps the retry usable from the keyboard', async () => {
      mockedChannel.getLastRegistrationOutcome.mockReturnValue('failed-retryable');
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      const control = await screen.findByRole('button', { name: 'Try again' });
      control.focus();
      await user.keyboard('{Enter}');

      expect(mockedChannel.ensureRegistered).toHaveBeenCalledTimes(1);
    });

    it('confirms the device once a retry registers it', async () => {
      mockedChannel.getLastRegistrationOutcome.mockReturnValue('failed-retryable');
      mockedChannel.ensureRegistered.mockImplementation(() => {
        mockedChannel.getLastRegistrationOutcome.mockReturnValue('succeeded');
        return Promise.resolve();
      });
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.click(await screen.findByRole('button', { name: 'Try again' }));

      expect(await screen.findByText('Allowed')).toBeVisible();
    });

    it('keeps the unfinished reading while the platform has not finished registering', async () => {
      mockedChannel.getLastRegistrationOutcome.mockReturnValue('failed-retryable');
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.click(await screen.findByRole('button', { name: 'Try again' }));

      await waitFor(() => {
        expect(mockedChannel.ensureRegistered).toHaveBeenCalledTimes(1);
      });
      expect(screen.getByText(UNFINISHED_MESSAGE)).toBeVisible();
    });

    it('says a device the server refused could not be set up', async () => {
      mockedChannel.getLastRegistrationOutcome.mockReturnValue('failed-terminal');
      renderWithProviders(<NotificationsSettings />);

      expect(await screen.findByText(REFUSED_MESSAGE)).toBeVisible();
      expect(screen.queryByText(UNFINISHED_MESSAGE)).not.toBeInTheDocument();
    });

    it('offers no retry for a device the server refused', async () => {
      mockedChannel.getLastRegistrationOutcome.mockReturnValue('failed-terminal');
      renderWithProviders(<NotificationsSettings />);

      await screen.findByText(REFUSED_MESSAGE);
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });

    it('confirms a device whose registration succeeded', async () => {
      mockedChannel.getLastRegistrationOutcome.mockReturnValue('succeeded');
      renderWithProviders(<NotificationsSettings />);

      expect(await screen.findByText('Allowed')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });

    it('keeps the blocked reading for a blocked device that also failed to register', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('denied');
      mockedChannel.getLastRegistrationOutcome.mockReturnValue('failed-retryable');
      renderWithProviders(<NotificationsSettings />);

      expect(await screen.findByText(BLOCKED_MESSAGE)).toBeVisible();
      expect(screen.queryByText(UNFINISHED_MESSAGE)).not.toBeInTheDocument();
    });
  });

  describe('sound', () => {
    beforeEach(() => {
      useNotificationActivityStore.setState({ soundEnabled: false });
      mockedFetchJson.mockResolvedValue(PREFERENCES);
    });

    it('leaves the chime off until it is asked for', async () => {
      renderWithProviders(<NotificationsSettings />);

      expect(await screen.findByRole('switch', { name: 'Sound' })).not.toBeChecked();
    });

    it('turns the chime on', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.click(await screen.findByRole('switch', { name: 'Sound' }));

      expect(useNotificationActivityStore.getState().soundEnabled).toBe(true);
      expect(screen.getByRole('switch', { name: 'Sound' })).toBeChecked();
    });

    it('unlocks audio as the chime goes on', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.click(await screen.findByRole('switch', { name: 'Sound' }));

      expect(mockedPrimeNotificationSound).toHaveBeenCalledTimes(1);
    });

    it('turns the chime back off', async () => {
      useNotificationActivityStore.setState({ soundEnabled: true });
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      await user.click(await screen.findByRole('switch', { name: 'Sound' }));

      expect(useNotificationActivityStore.getState().soundEnabled).toBe(false);
      expect(mockedPrimeNotificationSound).not.toHaveBeenCalled();
    });

    it('keeps the chime switch usable from the keyboard', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NotificationsSettings />);

      const soundSwitch = await screen.findByRole('switch', { name: 'Sound' });
      soundSwitch.focus();
      await user.keyboard(' ');

      expect(useNotificationActivityStore.getState().soundEnabled).toBe(true);
    });

    it('offers the chime while account settings are still loading', async () => {
      mockedFetchJson.mockImplementation(() => new Promise(() => {}));
      renderWithProviders(<NotificationsSettings />);

      expect(screen.getByRole('switch', { name: 'Sound' })).toBeInTheDocument();
      await findDeviceReading();
    });
  });

  describe('as a settings group', () => {
    beforeEach(() => {
      mockedFetchJson.mockResolvedValue(PREFERENCES);
    });

    it('titles the group Notifications as a level-2 heading', async () => {
      renderWithProviders(<NotificationsSettings />);

      const group = await screen.findByRole('region', { name: 'Notifications' });
      expect(within(group).getByRole('heading', { level: 2, name: 'Notifications' })).toBeVisible();
    });

    it('keeps the group description', async () => {
      renderWithProviders(<NotificationsSettings />);

      expect(
        await screen.findByText(
          'Push notifications for this account. They never carry message content, only a link back to the conversation.'
        )
      ).toBeVisible();
    });

    it('lands the notifications section jump on the group', async () => {
      renderWithProviders(<NotificationsSettings />);

      expect(await screen.findByRole('region', { name: 'Notifications' })).toHaveAttribute(
        'id',
        'notifications'
      );
    });

    it('orders the switches from the account switch to sound', async () => {
      renderWithProviders(<NotificationsSettings />);

      await screen.findByRole('switch', { name: 'All notifications' });
      const names = screen
        .getAllByRole('switch')
        .map((control) => document.querySelector(`label[for="${control.id}"]`)?.textContent);
      expect(names).toEqual([
        'All notifications',
        'New messages',
        'Finished runs',
        'Invitations and shares',
        'Quiet hours',
        'Sound',
      ]);
    });

    it('places the device row after the sound switch', async () => {
      renderWithProviders(<NotificationsSettings />);

      const reading = await findDeviceReading();
      const sound = screen.getByRole('switch', { name: 'Sound' });
      expect(
        sound.compareDocumentPosition(reading) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it('shows the hour controls between quiet hours and sound', async () => {
      mockedFetchJson.mockResolvedValue({
        ...PREFERENCES,
        quietHours: { startMinutes: 1320, endMinutes: 420, timezone: DEVICE_TIMEZONE },
      });
      renderWithProviders(<NotificationsSettings />);

      const from = await screen.findByLabelText('From');
      const quietHours = screen.getByRole('switch', { name: 'Quiet hours' });
      const sound = screen.getByRole('switch', { name: 'Sound' });
      expect(
        quietHours.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(from.compareDocumentPosition(sound) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('draws no legend', async () => {
      const { container } = renderWithProviders(<NotificationsSettings />);

      await screen.findByRole('switch', { name: 'All notifications' });
      expect(container.querySelector('legend')).toBeNull();
      expect(screen.queryByText('On this device')).not.toBeInTheDocument();
      expect(screen.queryByText('What you get notified about')).not.toBeInTheDocument();
    });

    it('draws no hand-rolled pulse', () => {
      const sources = Object.values(GROUP_SOURCES);
      expect(sources).toHaveLength(1);
      expect(sources[0]).not.toContain('animate-pulse');
    });
  });

  describe('device row', () => {
    beforeEach(() => {
      mockedFetchJson.mockResolvedValue(PREFERENCES);
    });

    it('reads a blocked device as Blocked with the way back', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('denied');
      renderWithProviders(<NotificationsSettings />);

      const reading = await findDeviceReading();
      expect(reading).toHaveTextContent(new RegExp(`^This device${BLOCKED_MESSAGE}Blocked$`));
      expect(within(reading).getByText('Blocked')).toHaveClass('text-warning-text');
      expect(within(reading).queryByRole('button')).not.toBeInTheDocument();
    });

    it('reads a granted device as Allowed in the success tone', async () => {
      renderWithProviders(<NotificationsSettings />);

      const reading = await findDeviceReading();
      expect(within(reading).getByText('Allowed')).toHaveClass('text-success-text');
      expect(within(reading).queryByRole('button')).not.toBeInTheDocument();
    });

    it('reads an unasked device as Not asked with the ask', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('default');
      renderWithProviders(<NotificationsSettings />);

      const reading = await findDeviceReading();
      expect(reading).toHaveTextContent(/^This deviceNot askedAllow notifications$/);
      expect(within(reading).getByText('Not asked')).toHaveClass('text-muted-foreground');
      expect(within(reading).getByRole('button', { name: 'Allow notifications' })).toBeVisible();
    });

    it('draws the ask as a block button, so its label wraps inside the row at large text', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('default');
      renderWithProviders(<NotificationsSettings />);

      const reading = await findDeviceReading();
      expect(within(reading).getByRole('button', { name: 'Allow notifications' })).toHaveAttribute(
        'data-block'
      );
    });

    it('draws the retry as a block button, so its label wraps inside the row at large text', async () => {
      mockedChannel.getLastRegistrationOutcome.mockReturnValue('failed-retryable');
      renderWithProviders(<NotificationsSettings />);

      const reading = await findDeviceReading();
      expect(within(reading).getByRole('button', { name: 'Try again' })).toHaveAttribute(
        'data-block'
      );
    });

    it('reads a device with no push path as Not supported', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('unsupported');
      renderWithProviders(<NotificationsSettings />);

      const reading = await findDeviceReading();
      expect(reading).toHaveTextContent(
        /^This deviceThis device can't show push notifications\.Not supported$/
      );
      expect(within(reading).getByText('Not supported')).toHaveClass('text-muted-foreground');
      expect(within(reading).queryByRole('button')).not.toBeInTheDocument();
    });

    it('reads an unfinished registration as Not set up with the retry', async () => {
      mockedChannel.getLastRegistrationOutcome.mockReturnValue('failed-retryable');
      renderWithProviders(<NotificationsSettings />);

      const reading = await findDeviceReading();
      expect(reading).toHaveTextContent(
        /^This deviceThis device is allowed to show notifications, but setup did not finish\. HushBox will try again next time you open the app\.Not set upTry again$/
      );
      expect(within(reading).getByText('Not set up')).toHaveClass('text-warning-text');
      expect(within(reading).getByRole('button', { name: 'Try again' })).toBeVisible();
    });

    it('reads a refused registration as Not set up without a retry', async () => {
      mockedChannel.getLastRegistrationOutcome.mockReturnValue('failed-terminal');
      renderWithProviders(<NotificationsSettings />);

      const reading = await findDeviceReading();
      expect(reading).toHaveTextContent(
        /^This deviceThis device could not be set up for notifications\. It may already be registered to another account\.Not set up$/
      );
      expect(within(reading).getByText('Not set up')).toHaveClass('text-warning-text');
      expect(within(reading).queryByRole('button')).not.toBeInTheDocument();
    });
  });
});
