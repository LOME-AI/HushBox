import * as React from 'react';
import { AsyncRegion, type SkeletonShape } from '@hushbox/ui/surface';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { SettingsRow } from '@/components/settings/settings-row';
import { ExternalPageLink } from '@/components/shared/external-page-link';
import {
  useNewsletterSettings,
  useUpdateNewsletterSettings,
} from '@/hooks/newsletter/use-newsletter-settings';

const TITLE = 'Mailing list';
const REGION_LABEL = 'Mailing list setting';
const LOAD_ERROR = 'Could not load this setting. Refresh to try again.';
const SWITCH_PLACEHOLDER: readonly SkeletonShape[] = [{ kind: 'line', width: '100%' }];

function Description(): React.JSX.Element {
  return (
    <>
      <span>
        A few letters a year to your account email. No tracking. Separate from account and billing
        emails.
      </span>{' '}
      <ExternalPageLink
        path={ROUTES.PRIVACY}
        className="text-primary hover:text-brand-red-hover focus-visible:outline-ring rounded-sm whitespace-nowrap underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        Privacy Policy
      </ExternalPageLink>
    </>
  );
}

/**
 * The switch always renders server truth, never local state: a
 * complaint-suppressed subscriber toggling on gets {subscribed: false} back
 * and the switch settles off with no error surface — deliberate product
 * behavior, not a failure.
 */
export function MailingListRow(): React.JSX.Element {
  const settings = useNewsletterSettings();
  const update = useUpdateNewsletterSettings();

  if (settings.isPending) {
    return (
      <SettingsRow
        kind="value"
        title={TITLE}
        description={<Description />}
        value={
          // The switch's width, so the row keeps its shape when the switch arrives.
          <span className="w-8">
            <AsyncRegion status="pending" label={REGION_LABEL} placeholder={SWITCH_PLACEHOLDER}>
              {null}
            </AsyncRegion>
          </span>
        }
      />
    );
  }

  if (settings.isError) {
    return (
      <SettingsRow
        kind="action"
        title={TITLE}
        description={<Description />}
        action={
          <AsyncRegion
            status="error"
            label={REGION_LABEL}
            placeholder={SWITCH_PLACEHOLDER}
            error={{ message: LOAD_ERROR }}
          >
            {null}
          </AsyncRegion>
        }
      />
    );
  }

  return (
    <SettingsRow
      kind="toggle"
      title={TITLE}
      description={<Description />}
      checked={settings.data.subscribed}
      disabled={update.isPending}
      switchTestId={TEST_IDS.settingsMailingListToggle}
      onCheckedChange={(checked) => {
        update.mutate({ subscribed: checked });
      }}
    />
  );
}
