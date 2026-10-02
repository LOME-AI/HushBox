import { AccountNav } from '@/components/settings/account-nav';
import { PageBody } from '@/components/shared/page-body';
import type * as React from 'react';
import type { KitSection } from './kit-sections';

const SAMPLE_GROUPS = ['Account', 'Security', 'Preferences', 'Notifications', 'Legal'];

/** A short page body, so the band's pinning shows while the sample groups scroll under it. */
function SampleFrame({
  caption,
  children,
}: Readonly<{ caption: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-muted-foreground font-mono">{caption}</p>
      <div className="border-border flex h-72 flex-col overflow-hidden rounded-lg border">
        {children}
      </div>
    </div>
  );
}

function SampleGroups(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      {SAMPLE_GROUPS.map((title) => (
        <div key={title} className="flex flex-col gap-1">
          <p className="text-title-3 text-primary">{title}</p>
          <p className="text-ui text-muted-foreground">Rows of the {title} group.</p>
        </div>
      ))}
    </div>
  );
}

const section: KitSection = {
  title: 'Settings nav',
  part: 5,
  render: () => (
    <>
      <SampleFrame caption="/settings, Security in view">
        <PageBody pinned={<AccountNav current="security" />}>
          <SampleGroups />
        </PageBody>
      </SampleFrame>
      <SampleFrame caption="/accessibility">
        <PageBody pinned={<AccountNav current="accessibility" />}>
          <SampleGroups />
        </PageBody>
      </SampleFrame>
    </>
  ),
};

export default section;
