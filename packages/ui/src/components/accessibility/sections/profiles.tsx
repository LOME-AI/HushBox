import * as React from 'react';

import { cn } from '../../../lib/utilities';
import { ACCESSIBILITY_PROFILES, type AccessibilityProfile } from '../lib/profiles';
import { useA11yStore } from '../store';

const QUICK_START_BUTTON_CLASSES = cn(
  'border-foreground/20 bg-background text-foreground hover:bg-accent hover:text-accent-foreground hover:border-foreground/40 focus-visible:border-ring focus-visible:ring-ring/50 flex w-full cursor-pointer flex-col gap-1 rounded-md border-2 px-3 py-2 text-left transition-colors outline-none focus-visible:ring-[3px]'
);

interface ProfileButtonProps {
  profile: AccessibilityProfile;
  onApply: (profile: AccessibilityProfile) => void;
}

function ProfileButton({ profile, onApply }: Readonly<ProfileButtonProps>): React.JSX.Element {
  return (
    <button
      type="button"
      data-slot="a11y-profile-button"
      data-profile-id={profile.id}
      onClick={() => {
        onApply(profile);
      }}
      className={QUICK_START_BUTTON_CLASSES}
    >
      <span className="text-sm font-medium">{profile.label}</span>
      <span className="text-muted-foreground text-xs">{profile.description}</span>
    </button>
  );
}

export function ProfilesSection(): React.JSX.Element {
  const update = useA11yStore((s) => s.update);
  const reset = useA11yStore((s) => s.reset);

  const applyProfile = React.useCallback(
    (profile: AccessibilityProfile): void => {
      reset();
      update(profile.preset);
    },
    [update, reset]
  );

  return (
    <section aria-labelledby="a11y-profiles-heading" className="flex flex-col gap-2">
      <h2 id="a11y-profiles-heading" className="text-lg font-semibold">
        Quick starts
      </h2>
      <p className="text-muted-foreground text-xs">
        One click replaces every setting with this profile&apos;s opinion.
      </p>
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          data-slot="a11y-profile-button"
          data-profile-id="default"
          onClick={reset}
          className={QUICK_START_BUTTON_CLASSES}
        >
          <span className="text-sm font-medium">Default</span>
          <span className="text-muted-foreground text-xs">Restore HushBox defaults.</span>
        </button>
        {ACCESSIBILITY_PROFILES.map((profile) => (
          <ProfileButton key={profile.id} profile={profile} onApply={applyProfile} />
        ))}
      </div>
    </section>
  );
}
