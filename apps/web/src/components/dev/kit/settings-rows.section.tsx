import * as React from 'react';
import { Button } from '@hushbox/ui/button';
import { AlertTriangle, Check, Icon, Shield } from '@hushbox/ui/icons';
import { SettingsGroup } from '@/components/settings/settings-group';
import { SettingsRow } from '@/components/settings/settings-row';
import { SettingsStatusBadge } from '@/components/settings/settings-status-badge';
import type { KitSection } from './kit-sections';

/** The samples open nothing; a row's press is what the kit shows. */
function ignore(): void {
  // A sample row has no destination.
}

function Toggle({
  title,
  description,
  initial,
}: Readonly<{ title: string; description: string; initial: boolean }>): React.JSX.Element {
  const [checked, setChecked] = React.useState(initial);
  return (
    <SettingsRow
      kind="toggle"
      title={title}
      description={description}
      checked={checked}
      onCheckedChange={setChecked}
    />
  );
}

/** Each island renders the groups again, so their ids come from `useId` rather than the page's. */
function SettingsRowsSample(): React.JSX.Element {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-9">
      <SettingsGroup id={`${id}-attention`} title="Needs attention" tone="attention">
        <SettingsRow
          kind="action"
          inline
          icon={<Icon icon={AlertTriangle} className="text-warning" />}
          title="Recovery phrase not saved"
          description="If you lose your password, this is your only recovery."
          action={
            <Button block onClick={ignore}>
              Save phrase
            </Button>
          }
        />
        <SettingsRow
          kind="action"
          inline
          icon={<Icon icon={Shield} className="text-warning" />}
          title="Two-factor authentication is off"
          description="A stolen password alone could open your account."
          action={
            <Button block onClick={ignore}>
              Turn on
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsGroup id={`${id}-account`} title="Account">
        <SettingsRow
          kind="value"
          title="Email"
          description="alice@hushbox.ai"
          value={<SettingsStatusBadge status="Verified" icon={Check} />}
        />
        <SettingsRow kind="value" title="Username" value={<span className="text-ui">alice</span>} />
      </SettingsGroup>
      <SettingsGroup id={`${id}-security`} title="Security">
        <SettingsRow
          kind="navigate"
          title="Change Password"
          description="Update your account password"
          onClick={ignore}
        />
        <SettingsRow
          kind="navigate"
          title="Two-Factor Authentication"
          description="Manage your authentication security"
          badge={<SettingsStatusBadge status="Enabled" />}
          onClick={ignore}
        />
        <SettingsRow
          kind="navigate"
          title="Recovery Phrase"
          description="Protect from forgetting your password"
          badge={<SettingsStatusBadge status="Disabled" />}
          onClick={ignore}
        />
      </SettingsGroup>
      <SettingsGroup
        id={`${id}-notifications`}
        title="Notifications"
        description="Push notifications for this account. They never carry message content, only a link back to the conversation."
      >
        <Toggle
          title="All notifications"
          description="Off stops every notification, on every device."
          initial
        />
        <Toggle
          title="Sound"
          description="Plays a short chime when something arrives while you're looking away."
          initial={false}
        />
        <SettingsRow
          kind="value"
          title="This device"
          description="It won't ask again. Allow notifications for HushBox in your device settings."
          value={<SettingsStatusBadge status="Blocked" />}
        />
      </SettingsGroup>
      <SettingsGroup id={`${id}-legal`} title="Legal">
        <SettingsRow kind="link" title="Terms of Service" external onOpen={ignore} />
        <SettingsRow kind="link" title="Privacy Policy" external onOpen={ignore} />
      </SettingsGroup>
      <SettingsGroup id={`${id}-danger`} title="Danger zone" tone="danger">
        <SettingsRow
          kind="action"
          description="Permanently delete your account and all associated data."
          action={
            <Button variant="destructive" block onClick={ignore}>
              Delete Account
            </Button>
          }
        />
      </SettingsGroup>
    </div>
  );
}

const section: KitSection = {
  title: 'Settings rows',
  part: 5,
  render: () => <SettingsRowsSample />,
};

export default section;
