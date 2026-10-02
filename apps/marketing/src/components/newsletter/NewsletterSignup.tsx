import * as React from 'react';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { ROUTES } from '@hushbox/shared/routes';
import { Button, ButtonRow } from '@hushbox/ui/button';
import { TextField } from '@hushbox/ui/field';
import { Icon, MailCheck } from '@hushbox/ui/icons';
import { Heading } from '@hushbox/ui/type';
import { getApiUrl } from '../../lib/api-url';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Marks the sent state, which /newsletter's page reads to drop its value blocks. */
export const NEWSLETTER_SENT_ATTRIBUTE = 'data-newsletter-sent';

interface NewsletterSignupProps {
  /** Compact embed for blog/welcome footers: a title line above the field. */
  compact?: boolean;
  /**
   * Shown under the form and never in the success state. Pages pass Astro-rendered markup here,
   * which React leaves unowned, so the growth script can tag its links before hydration.
   */
  children?: React.ReactNode;
}

/**
 * Newsletter signup island. Every submit with a well-formed email lands on
 * the same "check your inbox" state regardless of the response, so the UI
 * can never leak whether an address is already on the list (enumeration
 * safety lives server-side; this surface stays deliberately uniform).
 */
export function NewsletterSignup({
  compact = false,
  children,
}: Readonly<NewsletterSignupProps>): React.JSX.Element {
  const [email, setEmail] = React.useState('');
  const [invalid, setInvalid] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [ready, setReady] = React.useState(false);

  // Runs only after hydration, so static Astro HTML never carries the signal.
  React.useEffect(() => {
    setReady(true);
  }, []);

  const readyAttribute = ready ? { [TEST_SIGNALS.newsletterReady]: 'true' } : {};

  const handleSubmit = (event: React.SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!EMAIL_PATTERN.test(email)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    // Fire and forget: the outcome must never change what the user sees.
    void (async (): Promise<void> => {
      try {
        await fetch(`${getApiUrl()}/newsletter/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
      } catch {
        // Deliberately swallowed: the success state is identical either way.
      }
    })();
    setDone(true);
  };

  if (done) {
    return (
      <div
        {...readyAttribute}
        {...{ [NEWSLETTER_SENT_ATTRIBUTE]: '' }}
        role="status"
        className="mx-auto flex w-full max-w-md flex-col items-center gap-3 pt-2 text-center"
      >
        <span
          aria-hidden="true"
          className="bg-brand-red-subtle text-brand-red mb-1 grid size-14 place-items-center rounded-full"
        >
          <Icon icon={MailCheck} size="xl" />
        </span>
        <Heading level={2} variant="title-1">
          Check your inbox
        </Heading>
        <p className="text-foreground font-serif text-base/[1.6]">
          Click the link in the email to confirm.
        </p>
        <div className="mt-3 w-full">
          <ButtonRow>
            <Button asChild variant="outline" size="lg">
              <a href={ROUTES.BLOG}>Read the blog</a>
            </Button>
            <Button asChild size="lg">
              <a href={ROUTES.CHAT}>Try HushBox Free</a>
            </Button>
          </ButtonRow>
        </div>
      </div>
    );
  }

  return (
    <form
      {...readyAttribute}
      noValidate
      onSubmit={handleSubmit}
      className="mx-auto flex w-full max-w-md flex-col gap-3 text-start"
    >
      {compact && (
        <p className="text-foreground text-center font-serif text-base">Join our newsletter</p>
      )}
      {/* No `name`: a native submit before hydration would put the address in the page URL.
          `type` and `autoComplete` are what browser autofill reads. */}
      <TextField
        label="Email address"
        data-testid={TEST_IDS.newsletterSignupInput}
        type="email"
        autoComplete="email"
        {...(invalid && { error: 'Please enter a valid email address.' })}
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
        }}
      />
      <Button type="submit" block data-testid={TEST_IDS.newsletterSignupSubmit}>
        Subscribe
      </Button>
      {children}
    </form>
  );
}
