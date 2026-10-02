import { cn } from '@hushbox/ui';
import { ChevronUp, ChevronsUpDown, Icon } from '@hushbox/ui/icons';
import { TEST_IDS } from '@hushbox/shared';
import { Avatar } from '@/components/shared/avatar';
import type * as React from 'react';

interface SignedInAccount {
  name: string;
  /** The balance as shown, or its loading placeholder. */
  balance: string;
}

type AccountButtonProps = Omit<React.ComponentProps<'button'>, 'children'> & {
  /** The signed-in account, or `null` for a trial visitor. */
  account: SignedInAccount | null;
  collapsed: boolean;
};

const ROW = 'w-full gap-2.5 p-2 text-left';

// The rail's square matches the rail's other rows, and grows to the touch floor.
const RAIL = 'size-9 shrink-0 justify-center p-0 pointer-coarse:size-11';

/**
 * The sidebar foot's account button: the avatar, the name and, when signed in, the balance,
 * over a chevron that says a menu opens above it. It spreads what a menu trigger hands it,
 * and keeps the base layer's focus outline.
 */
export function AccountButton({
  account,
  collapsed,
  className,
  ...rest
}: Readonly<AccountButtonProps>): React.JSX.Element {
  const name = account?.name ?? 'Trial User';
  return (
    <button
      type="button"
      data-testid={TEST_IDS.accountButton}
      className={cn(
        'hover:bg-accent aria-expanded:bg-accent flex cursor-pointer items-center rounded-md transition-colors duration-150',
        collapsed ? RAIL : ROW,
        className
      )}
      {...rest}
    >
      {account === null ? <Avatar person /> : <Avatar name={account.name} />}
      {collapsed ? (
        <span className="sr-only">{name}</span>
      ) : (
        <>
          <span className="text-ui-sm flex min-w-0 flex-1 flex-col">
            <span className="truncate font-semibold">{name}</span>
            {account !== null && (
              <span className="text-muted-foreground font-mono tabular-nums">
                {account.balance}
              </span>
            )}
          </span>
          <Icon
            icon={account === null ? ChevronUp : ChevronsUpDown}
            className="text-muted-foreground"
          />
        </>
      )}
    </button>
  );
}
