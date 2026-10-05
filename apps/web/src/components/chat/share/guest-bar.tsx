import { Link } from '@tanstack/react-router';
import { ROUTES, TEST_IDS, TEST_ID_BUILDERS, notices } from '@hushbox/shared';
import { Button } from '@hushbox/ui/button';
import { Notice } from '@hushbox/ui/notice';
import { NOTICE_SHAPES, composerNoticeShape } from '@/lib/chat/notice-shape';
import type * as React from 'react';

const READ_ONLY = notices('conversation_read_only');

interface GuestBarProps {
  signedIn: boolean;
}

/** What a read-only link guest sees in the composer's place. */
export function GuestBar({ signedIn }: Readonly<GuestBarProps>): React.JSX.Element {
  const { tone, icon } = NOTICE_SHAPES[composerNoticeShape(READ_ONLY)];
  return (
    <div data-testid={TEST_IDS.guestBar} data-chrome="" className="flex flex-col gap-2">
      <Notice
        tone={tone}
        icon={icon}
        placement="composer"
        data-testid={TEST_ID_BUILDERS.budgetMessage(READ_ONLY.id)}
      >
        {READ_ONLY.message}
      </Notice>
      {!signedIn && (
        <Button asChild block>
          <Link to={ROUTES.SIGNUP} data-testid={TEST_IDS.guestBarSignUp}>
            Sign Up
          </Link>
        </Button>
      )}
    </div>
  );
}
