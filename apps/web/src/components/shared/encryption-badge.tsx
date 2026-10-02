import * as React from 'react';
import { ShieldCheck } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@hushbox/ui/popover';
import { TEST_IDS } from '@hushbox/shared';
import { getLinkGuestAuth } from '@/lib/auth/link-guest-auth.js';

interface EncryptionBadgeProps {
  isAuthenticated: boolean;
}

const ENCRYPTED_LINE = 'Encrypted. Not even we can read your messages.';
const ZDR_LINE = 'We only partner with AI providers that never store or train on your data.';
const SIGN_UP_LINE = 'Sign up to save encrypted chats';

export function EncryptionBadge({
  isAuthenticated,
}: Readonly<EncryptionBadgeProps>): React.JSX.Element {
  // Anonymous is not the same as accountless. A link guest reads and writes a
  // conversation that IS encrypted — under the epoch key its link derives — so
  // offering to encrypt what they save tells them something untrue about their
  // own messages. The link-guest store is the same fact `getUserTier` consults
  // to answer `guest` rather than `trial`, so the two cannot disagree.
  const isEncrypted = isAuthenticated || getLinkGuestAuth() !== null;
  const lines = isEncrypted ? [ENCRYPTED_LINE, ZDR_LINE] : [ZDR_LINE, SIGN_UP_LINE];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid={TEST_IDS.encryptionBadge}
          role="img"
          // The name carries the whole hint for a reader that never opens it.
          aria-label={lines.join(' ')}
          // The tooltip trigger points this at the open hint, which repeats the name word
          // for word; overriding it keeps a screen reader from reading the hint twice.
          aria-describedby={undefined}
          // The hint opens on focus, so this tab stop is how a keyboard reaches it.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the hint opens on focus, so keyboard users need this tab stop to read it
          tabIndex={0}
          className="text-success relative inline-flex h-8 items-center justify-center rounded-sm pointer-coarse:before:absolute pointer-coarse:before:top-1/2 pointer-coarse:before:left-1/2 pointer-coarse:before:size-11 pointer-coarse:before:-translate-1/2"
        >
          <ShieldCheck
            data-testid={TEST_IDS.encryptionBadgeIcon}
            className="text-success h-5 w-5"
            aria-hidden="true"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={4}
        collisionPadding={12}
        className="bg-popover text-popover-foreground text-ui-sm w-64 max-w-(--radix-tooltip-content-available-width) border px-3 py-2.5 text-wrap shadow-md [&_svg]:invisible"
      >
        {/* The space between the blocks keeps the lines apart in the text a reader is given. */}
        {lines.map((line, index) => (
          <React.Fragment key={line}>
            {index > 0 && ' '}
            <span className="block">{line}</span>
          </React.Fragment>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
