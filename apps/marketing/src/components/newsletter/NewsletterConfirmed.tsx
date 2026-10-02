import * as React from 'react';
import { asErrorCode, friendlyErrorMessage } from '@hushbox/shared';
import { buttonVariants } from '@hushbox/ui';
import { Heading } from '@hushbox/ui/type';
import { useTokenAction } from './use-token-action';

/**
 * Center content of the fullscreen confirmed-page hero. Rendered inside
 * PageHero's slot, so the CipherWall behind it carries the reveal: while
 * pending the wall's texture stands alone (status text is screen-reader
 * only), and on success the headline appears in the wall's exclusion zone,
 * the moment the wall has been decoding toward.
 */
export function NewsletterConfirmed(): React.JSX.Element {
  const { status, code } = useTokenAction('/newsletter/confirm');

  // The page ships the honest static title "Confirm your subscription";
  // only a verified success may claim the celebratory one.
  React.useEffect(() => {
    if (status === 'success') {
      document.title = "You're on the list | HushBox";
    }
  }, [status]);

  switch (status) {
    case 'pending': {
      return (
        <p role="status" className="sr-only">
          Confirming your subscription
        </p>
      );
    }
    case 'success': {
      return (
        <div className="flex flex-col items-center gap-6">
          <Heading level={1} variant="site-hero">
            You&apos;re on the list.
          </Heading>
          <p className="text-foreground max-w-xl font-serif text-lg">
            Expect a few letters a year, written when there&apos;s something worth saying.
          </p>
          <a href="/blog" className={buttonVariants({ variant: 'ghost', size: 'lg' })}>
            Read the blog
          </a>
        </div>
      );
    }
    case 'error': {
      return (
        <div className="flex flex-col items-center gap-4">
          <p className="text-foreground max-w-xl font-serif text-lg">
            {friendlyErrorMessage(asErrorCode(code))}
          </p>
          <a href="/newsletter" className="text-primary underline underline-offset-4">
            Sign up again
          </a>
        </div>
      );
    }
    case 'missing': {
      return (
        <div className="flex flex-col items-center gap-4">
          <p className="text-foreground max-w-xl font-serif text-lg">
            This page confirms a newsletter signup from the link in your email.
          </p>
          <a href="/newsletter" className="text-primary underline underline-offset-4">
            Sign up for the newsletter
          </a>
        </div>
      );
    }
  }
}
