import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ROUTES, TERMS_BETA_SECTION } from '@hushbox/shared';
import { Button } from '@hushbox/ui/button';
import { Icon, ShieldCheck } from '@hushbox/ui/icons';
import { Heading } from '@hushbox/ui/type';
import { AuthFormHeader } from '@/components/auth/auth-form-header';
import { ExternalPageLink } from '@/components/shared/external-page-link';

interface BetaWelcomeStepProps {
  onJoin: () => void;
}

const BETA_TERMS_PATH = `${ROUTES.TERMS}#${TERMS_BETA_SECTION.id}`;

/**
 * Each line is a shortened form of a point in the Terms' beta section, which the user
 * agrees to through the sign-up form's legal sentence; a line here that the Terms no
 * longer back is a false promise.
 */
const HEADS_UP =
  'We ship fast, so expect some downtime and the occasional broken feature. As we build, some features may change for good or disappear entirely.';

const NEVER_CHANGES: readonly string[] = [
  "We can't read your messages.",
  'Your purchased credit is never lost to our mistakes.',
];

/** The beta welcome `/signup` opens on while the product is in beta, before the form. */
export function BetaWelcomeStep({ onJoin }: Readonly<BetaWelcomeStepProps>): React.JSX.Element {
  const headsUpId = React.useId();
  const neverChangesId = React.useId();

  return (
    <div>
      <AuthFormHeader
        title="Welcome to the HushBox beta"
        subtitle="Thanks for joining early. You get every new feature the moment it ships, and your feedback shapes what we build next."
        subtitleTone="text"
      />

      <section aria-labelledby={headsUpId} className="mb-5">
        <Heading level={2} variant="title-3" tone="ink" id={headsUpId}>
          Heads up
        </Heading>
        <ul className="text-muted-foreground mt-1.5 text-base">
          <li>{HEADS_UP}</li>
        </ul>
      </section>

      <section
        aria-labelledby={neverChangesId}
        className="bg-card border-border mb-6 rounded-lg border p-4"
      >
        <Heading level={2} variant="title-3" id={neverChangesId}>
          What never changes
        </Heading>
        <ul className="mt-3 space-y-2.5">
          {NEVER_CHANGES.map((line) => (
            <li key={line} className="text-foreground flex items-start gap-3 text-base">
              <Icon icon={ShieldCheck} size="lg" className="text-primary mt-0.5 shrink-0" />
              {line}
            </li>
          ))}
        </ul>
      </section>

      <Button type="button" size="xl" block onClick={onJoin}>
        Join the beta
      </Button>

      <p className="mt-4 text-center text-sm">
        <ExternalPageLink path={BETA_TERMS_PATH} className="text-primary hover:underline">
          Read the full beta terms
        </ExternalPageLink>
      </p>

      <p className="text-muted-foreground mt-2 text-center text-sm">
        Already have an account?{' '}
        <Link to={ROUTES.LOGIN} className="text-primary hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
