import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@hushbox/ui';
import { ROUTES } from '@hushbox/shared';

interface EncryptionBadgeProps {
  isAuthenticated: boolean;
}

export function EncryptionBadge({
  isAuthenticated,
}: Readonly<EncryptionBadgeProps>): React.JSX.Element {
  const zdrLine = (
    <>
      <span className="block">We only partner with AI providers that</span>
      <span className="block">never store or train on your data.</span>
    </>
  );

  const message = isAuthenticated ? (
    <>
      Encrypted — not even we can read your messages.
      <br />
      {zdrLine}
    </>
  ) : (
    <>
      {zdrLine}
      <br />
      <Link to={ROUTES.SIGNUP} className="text-primary font-medium hover:underline">
        Sign up
      </Link>{' '}
      to save encrypted chats
    </>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-testid="encryption-badge" className="inline-flex items-center">
          <ShieldCheck
            data-testid="encryption-badge-icon"
            className="h-5 w-5 text-green-500"
            aria-hidden="true"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="bg-popover text-popover-foreground border shadow-md [&>svg]:hidden"
      >
        {message}
      </TooltipContent>
    </Tooltip>
  );
}
