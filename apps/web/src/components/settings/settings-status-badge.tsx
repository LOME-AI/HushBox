import { type IconComponent } from '@hushbox/ui/icons';
import { Badge, type BadgeTone } from '@hushbox/ui/marks';
import type * as React from 'react';

export type SettingsStatus =
  | 'Enabled'
  | 'Active'
  | 'Verified'
  | 'Disabled'
  | 'Not set'
  | 'Loading...'
  | 'Not verified'
  | 'Blocked'
  | 'Allowed'
  | 'Not asked'
  | 'Not supported'
  | 'Not set up';

const STATUS_TONE: Readonly<Record<SettingsStatus, BadgeTone>> = {
  Enabled: 'success',
  Active: 'success',
  Verified: 'success',
  Disabled: 'neutral',
  'Not set': 'neutral',
  'Loading...': 'neutral',
  'Not verified': 'warning',
  Blocked: 'warning',
  Allowed: 'success',
  'Not asked': 'neutral',
  'Not supported': 'neutral',
  'Not set up': 'warning',
};

/** A settings status as a badge in the tone that status always takes. */
export function SettingsStatusBadge({
  status,
  icon,
}: Readonly<{ status: SettingsStatus; icon?: IconComponent }>): React.JSX.Element {
  return (
    <Badge tone={STATUS_TONE[status]} {...(icon !== undefined && { icon })}>
      {status}
    </Badge>
  );
}
