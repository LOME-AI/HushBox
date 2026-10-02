import * as React from 'react';
import { ERROR_CODES, asErrorCode, friendlyErrorMessage } from '@hushbox/shared';
import { Heading } from '@hushbox/ui/type';
import { useTokenAction } from './use-token-action';

/**
 * Human-visible landing for the footer unsubscribe link (mail clients may
 * also POST the one-click endpoint directly, never reaching this page). A
 * missing token means a mangled link, so it renders as the same invalid-link
 * state rather than a separate neutral one.
 */
export function NewsletterUnsubscribed(): React.JSX.Element {
  const { status, code } = useTokenAction('/newsletter/unsubscribe');

  switch (status) {
    case 'pending': {
      return (
        <p role="status" className="text-muted-foreground font-serif text-lg">
          Unsubscribing
        </p>
      );
    }
    case 'success': {
      return (
        <div className="flex flex-col items-center gap-4 wrap-anywhere">
          <Heading level={1} variant="site-title">
            You&apos;re unsubscribed.
          </Heading>
          <p className="text-foreground font-serif text-lg">No further emails.</p>
          <a href="/newsletter" className="text-primary text-sm underline underline-offset-4">
            Changed your mind? Sign up again
          </a>
        </div>
      );
    }
    case 'error':
    case 'missing': {
      return (
        <div className="flex flex-col items-center gap-4">
          <p className="text-foreground max-w-xl font-serif text-lg">
            {friendlyErrorMessage(asErrorCode(code) ?? ERROR_CODES.NEWSLETTER_UNSUBSCRIBE_INVALID)}
          </p>
          <a href="/newsletter" className="text-primary underline underline-offset-4">
            Go to the newsletter page
          </a>
        </div>
      );
    }
  }
}
