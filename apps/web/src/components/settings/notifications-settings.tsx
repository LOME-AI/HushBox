import * as React from 'react';
import { Button } from '@hushbox/ui/button';
import { SelectField } from '@hushbox/ui/field';
import { AsyncRegion } from '@hushbox/ui/surface';
import { HOUR_MINUTES } from '@hushbox/shared/durations';
import { SettingsGroup } from '@/components/settings/settings-group';
import { SettingsRow } from '@/components/settings/settings-row';
import { SettingsStatusBadge } from '@/components/settings/settings-status-badge';
import { notificationChannel } from '@/lib/notification-channel';
import { useNotificationActivityStore } from '@/stores/activity/notification';
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from '@/hooks/notifications/use-notification-preferences';
import type {
  NotificationPreferences,
  NotificationPreferencesUpdate,
} from '@/hooks/notifications/use-notification-preferences';
import type { PushPermissionState } from '@/lib/notification-channel';
import type { RegistrationOutcome } from '@/lib/notification-channel/types.js';
import type { SettingsSectionId } from '@/hooks/ui/use-section-in-view';
import type { SettingsStatus } from '@/components/settings/settings-status-badge';

type QuietHours = NonNullable<NotificationPreferences['quietHours']>;

const SECTION_ID: SettingsSectionId = 'notifications';

const CATEGORIES = [
  {
    field: 'messages',
    label: 'New messages',
    description: 'Replies in conversations you are part of.',
  },
  {
    field: 'runCompletion',
    label: 'Finished runs',
    description: 'When a model finishes work you started.',
  },
  {
    field: 'membership',
    label: 'Invitations and shares',
    description: 'When someone adds you to a conversation or shares one with you.',
  },
] as const;

interface DeviceStatus {
  status: SettingsStatus;
  sentence?: string;
}

/**
 * What each platform answer means for the person reading it. `denied` says the
 * prompt is gone for good because it is: browsers and phones raise it once, and
 * the only way back is their own settings — telling them to try the switch
 * again would send them in a circle.
 */
const PERMISSION_STATUS: Readonly<Record<PushPermissionState, DeviceStatus>> = {
  granted: { status: 'Allowed' },
  default: { status: 'Not asked' },
  denied: {
    status: 'Blocked',
    sentence: "It won't ask again. Allow notifications for HushBox in your device settings.",
  },
  unsupported: {
    status: 'Not supported',
    sentence: "This device can't show push notifications.",
  },
};

/** The outcomes that contradict a granted permission, tied to their source union. */
type RegistrationFailure = Extract<RegistrationOutcome, 'failed-retryable' | 'failed-terminal'>;

function isRegistrationFailure(outcome: RegistrationOutcome): outcome is RegistrationFailure {
  return outcome === 'failed-retryable' || outcome === 'failed-terminal';
}

/**
 * What a granted device says when the registration behind that grant did not
 * land, whether or not an attempt reached the POST. The two readings are
 * deliberately different sentences: a conflict is refused for as long as
 * another account holds the endpoint or token, so it must not carry the
 * promise of a retry that no later attempt can keep.
 */
const REGISTRATION_FAILURE_MESSAGE: Readonly<Record<RegistrationFailure, string>> = {
  'failed-retryable':
    'This device is allowed to show notifications, but setup did not finish. HushBox will try again next time you open the app.',
  'failed-terminal':
    'This device could not be set up for notifications. It may already be registered to another account.',
};

const HOUR_OPTIONS = Array.from({ length: 24 }, (_unused, hour) => ({
  value: String(hour * HOUR_MINUTES),
  label: `${String(hour).padStart(2, '0')}:00`,
}));

const PREFERENCES_PLACEHOLDER = [{ kind: 'block', height: 'md' }] as const;

const DEFAULT_QUIET_START_MINUTES = 22 * HOUR_MINUTES;
const DEFAULT_QUIET_END_MINUTES = 7 * HOUR_MINUTES;

interface HourSelectProps {
  label: string;
  minutes: number;
  disabled: boolean;
  onSelect: (minutes: number) => void;
}

function HourSelect({
  label,
  minutes,
  disabled,
  onSelect,
}: Readonly<HourSelectProps>): React.JSX.Element {
  return (
    <div className="w-28">
      <SelectField
        label={label}
        value={String(minutes)}
        options={HOUR_OPTIONS}
        disabled={disabled}
        onValueChange={(next) => {
          onSelect(Number(next));
        }}
      />
    </div>
  );
}

interface QuietHoursFieldsProps {
  quietHours: QuietHours;
  deviceTimezone: string;
  disabled: boolean;
  onChange: (next: QuietHours) => void;
}

/**
 * The zone on display is the saved one, because that is the zone the server
 * evaluates the window in. It is only re-stamped from the device when a bound
 * is written, so someone who travelled keeps their old zone — and their old
 * quiet window — until they change a time here. Showing the device zone instead
 * would claim a window the server is not enforcing.
 */
function QuietHoursFields({
  quietHours,
  deviceTimezone,
  disabled,
  onChange,
}: Readonly<QuietHoursFieldsProps>): React.JSX.Element {
  return (
    <div role="group" aria-label="Quiet hours" className="space-y-2 pb-4">
      <div className="flex flex-wrap items-end gap-4">
        <HourSelect
          label="From"
          minutes={quietHours.startMinutes}
          disabled={disabled}
          onSelect={(startMinutes) => {
            onChange({ ...quietHours, startMinutes, timezone: deviceTimezone });
          }}
        />
        <HourSelect
          label="Until"
          minutes={quietHours.endMinutes}
          disabled={disabled}
          onSelect={(endMinutes) => {
            onChange({ ...quietHours, endMinutes, timezone: deviceTimezone });
          }}
        />
      </div>
      <p className="text-muted-foreground text-sm">{`Hours are read in ${quietHours.timezone}.`}</p>
      {quietHours.timezone !== deviceTimezone && (
        <p className="text-muted-foreground text-sm">
          {`This device is in ${deviceTimezone}. Change a time to move quiet hours here.`}
        </p>
      )}
    </div>
  );
}

interface PreferenceControlsProps {
  preferences: NotificationPreferences;
  disabled: boolean;
  onSave: (next: NotificationPreferencesUpdate) => void;
}

function PreferenceControls({
  preferences,
  disabled,
  onSave,
}: Readonly<PreferenceControlsProps>): React.JSX.Element {
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { quietHours } = preferences;

  // The rows sit one level inside the group's list, behind the loading region, so
  // they draw the list's hairlines between themselves.
  return (
    <div className="border-border flex flex-col [&>*+*]:border-t">
      <SettingsRow
        kind="toggle"
        title="All notifications"
        description="Off stops every notification, on every device."
        checked={preferences.globalEnabled}
        disabled={disabled}
        onCheckedChange={(globalEnabled) => {
          onSave({ ...preferences, globalEnabled });
        }}
      />
      {CATEGORIES.map((category) => (
        <SettingsRow
          key={category.field}
          kind="toggle"
          title={category.label}
          description={category.description}
          checked={preferences[category.field]}
          disabled={disabled}
          onCheckedChange={(checked) => {
            onSave({ ...preferences, [category.field]: checked });
          }}
        />
      ))}
      <div>
        <SettingsRow
          kind="toggle"
          title="Quiet hours"
          description="Notifications that arrive during quiet hours are dropped, not delivered later."
          checked={quietHours !== null}
          disabled={disabled}
          onCheckedChange={(checked) => {
            onSave({
              ...preferences,
              quietHours: checked
                ? {
                    startMinutes: DEFAULT_QUIET_START_MINUTES,
                    endMinutes: DEFAULT_QUIET_END_MINUTES,
                    timezone: deviceTimezone,
                  }
                : null,
            });
          }}
        />
        {quietHours !== null && (
          <QuietHoursFields
            quietHours={quietHours}
            deviceTimezone={deviceTimezone}
            disabled={disabled}
            onChange={(next) => {
              onSave({ ...preferences, quietHours: next });
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The platform's answer and this session's registration outcome, held as one
 * value because they are only ever true together: the outcome has no
 * subscription to observe, so it is sampled at the moment the platform answers
 * and a reading is never half-refreshed.
 */
interface DeviceReading {
  permission: PushPermissionState | null;
  outcome: RegistrationOutcome;
}

const UNREAD_DEVICE: DeviceReading = { permission: null, outcome: 'not-attempted' };

interface DevicePermissionState extends DeviceReading {
  isAsking: boolean;
  isRetrying: boolean;
  ask: () => void;
  retry: () => void;
  refresh: () => void;
}

/**
 * This device's side of the story, read through the same facade the one-time
 * prompt uses. It is deliberately a separate reading from the account
 * preferences: the switches say what the server will send, the platform says
 * whether anything can arrive, and they disagree often enough that the group
 * has to show both. `null` means not read yet — the group says nothing rather
 * than guessing.
 */
function useDevicePermission(): DevicePermissionState {
  const [reading, setReading] = React.useState<DeviceReading>(UNREAD_DEVICE);
  const [isAsking, setIsAsking] = React.useState(false);
  const [isRetrying, setIsRetrying] = React.useState(false);

  const refresh = React.useCallback((): void => {
    void (async (): Promise<void> => {
      try {
        const permission = await notificationChannel.getPermissionState();
        setReading({ permission, outcome: notificationChannel.getLastRegistrationOutcome() });
      } catch {
        // An unreadable platform is not an answer: keep the last known state
        // rather than claiming one the device never gave.
      }
    })();
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const ask = React.useCallback((): void => {
    setIsAsking(true);
    void (async (): Promise<void> => {
      try {
        const permission = await notificationChannel.requestPermissionAndRegister();
        setReading({ permission, outcome: notificationChannel.getLastRegistrationOutcome() });
      } catch {
        // The grant can land and registration still fail; re-read the platform
        // instead of assuming which of the two happened.
        refresh();
      } finally {
        setIsAsking(false);
      }
    })();
  }, [refresh]);

  const retry = React.useCallback((): void => {
    setIsRetrying(true);
    void (async (): Promise<void> => {
      try {
        await notificationChannel.ensureRegistered();
      } catch {
        // Registration records its own outcome, so the refreshed reading is
        // the answer; push is best-effort and a throw here is not the story.
      } finally {
        setIsRetrying(false);
        refresh();
      }
    })();
  }, [refresh]);

  return { ...reading, isAsking, isRetrying, ask, retry, refresh };
}

/**
 * What this device will actually do with a notification.
 *
 * Without this, the account switch is the only thing on screen and it lies by
 * omission: someone who answered "Later" — or blocked the prompt — sees an "on"
 * switch and no notifications, with no route back, because the platform prompt
 * is raised once per device and never again.
 */
function DevicePermission({
  permission,
  outcome,
  isAsking,
  isRetrying,
  ask,
  retry,
}: Readonly<Omit<DevicePermissionState, 'refresh'>>): React.JSX.Element | null {
  if (permission === null) return null;

  // A failed registration only contradicts a granted permission. On every other
  // answer the platform is the reason nothing arrives, and saying so twice would
  // send the reader after the wrong fix.
  const failure = permission === 'granted' && isRegistrationFailure(outcome) ? outcome : null;
  const reading: DeviceStatus =
    failure === null
      ? PERMISSION_STATUS[permission]
      : { status: 'Not set up', sentence: REGISTRATION_FAILURE_MESSAGE[failure] };

  let control: React.JSX.Element | null = null;
  if (permission === 'default') {
    control = (
      <Button size="sm" block onClick={ask} disabled={isAsking}>
        Allow notifications
      </Button>
    );
  } else if (failure === 'failed-retryable') {
    control = (
      <Button size="sm" block onClick={retry} disabled={isRetrying}>
        Try again
      </Button>
    );
  }

  return (
    <div aria-live="polite">
      <SettingsRow
        kind="value"
        title="This device"
        {...(reading.sentence !== undefined && { description: reading.sentence })}
        value={<SettingsStatusBadge status={reading.status} />}
      />
      {control === null ? null : <div className="pb-4">{control}</div>}
    </div>
  );
}

/**
 * The chime that plays when activity arrives here. It is a browser setting, not
 * an account one: it lives in this device's store, it is saved the moment it is
 * flipped, and the flip itself is the gesture browsers require before audio may
 * play unprompted — which is why the store's setter is the only way to turn it
 * on. Sound never carries a signal on its own; the badge and the announcer say
 * the same thing.
 */
function SoundSetting(): React.JSX.Element {
  const soundEnabled = useNotificationActivityStore((state) => state.soundEnabled);
  const setSoundEnabled = useNotificationActivityStore((state) => state.setSoundEnabled);

  return (
    <SettingsRow
      kind="toggle"
      title="Sound"
      description="Plays a short chime when something arrives while you're looking away."
      checked={soundEnabled}
      onCheckedChange={setSoundEnabled}
    />
  );
}

/**
 * Account-level notification settings.
 *
 * The switches are account state, but the global one also owns this device's
 * registration: turning it off stops delivery here immediately rather than
 * leaving a live subscription the server would only ever refuse to use, and
 * turning it on asks for permission through the same facade the one-time
 * prompt uses. That device call is best-effort; the saved preference is what
 * decides delivery.
 */
export function NotificationsSettings(): React.JSX.Element {
  const preferences = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();
  const device = useDevicePermission();
  const savedGlobalEnabled = preferences.data?.globalEnabled;
  const { refresh: refreshPermission } = device;

  const handleSave = React.useCallback(
    (next: NotificationPreferencesUpdate): void => {
      const globalChanged = next.globalEnabled !== savedGlobalEnabled;
      update.mutate(next, {
        onSuccess: (): void => {
          if (!globalChanged) return;
          void (async (): Promise<void> => {
            try {
              if (next.globalEnabled) {
                await notificationChannel.requestPermissionAndRegister();
              } else {
                await notificationChannel.unregister();
              }
            } catch {
              // Best-effort: the saved preference already decides delivery, and
              // registration heals on the next authenticated app start.
            } finally {
              // Whatever the device answered, the group must show it: a saved
              // "on" preference over a blocked device would otherwise read as
              // working notifications.
              refreshPermission();
            }
          })();
        },
      });
    },
    [refreshPermission, savedGlobalEnabled, update]
  );

  let status: 'pending' | 'error' | 'ready' = 'ready';
  if (preferences.isPending) status = 'pending';
  else if (preferences.isError) status = 'error';

  return (
    <SettingsGroup
      id={SECTION_ID}
      title="Notifications"
      description="Push notifications for this account. They never carry message content, only a link back to the conversation."
    >
      {/* The loading and error lines take the rows' breathing room from the list's rules. */}
      <div className={status === 'ready' ? undefined : 'py-4'}>
        <AsyncRegion
          status={status}
          label="Notification settings"
          placeholder={PREFERENCES_PLACEHOLDER}
          error={{ message: 'Could not load these settings. Refresh to try again.' }}
        >
          {preferences.data === undefined ? null : (
            <PreferenceControls
              preferences={preferences.data}
              disabled={update.isPending}
              onSave={handleSave}
            />
          )}
        </AsyncRegion>
      </div>
      <SoundSetting />
      <DevicePermission
        permission={device.permission}
        outcome={device.outcome}
        isAsking={device.isAsking}
        isRetrying={device.isRetrying}
        ask={device.ask}
        retry={device.retry}
      />
    </SettingsGroup>
  );
}
