import * as React from 'react';
import { cn } from '@hushbox/ui';
import { Button, IconButton } from '@hushbox/ui/button';
import { ChevronDown, DollarSign, Icon } from '@hushbox/ui/icons';
import { Collapse } from '@hushbox/ui/motion';
import { useFormFactor } from '@hushbox/ui/platform';
import { Tooltip, TooltipContent, TooltipTrigger } from '@hushbox/ui/popover';
import { TEST_IDS } from '@hushbox/shared';
import { formatBalance } from '@/lib/billing/format';
import { budgetSummary, fundedLine, type FundedLine } from '@/lib/chat/member-money';
import { budgetRowName } from '@/lib/chat/link-label';
import { useNamingReads } from '@/lib/chat/use-naming-reads';
import { useConversationBudgets } from '@/hooks/billing/use-conversation-budgets';
import { useLinkGuestActive } from '@/lib/auth/link-guest-auth';
import type { ConversationBudgetsResponse } from '@/hooks/billing/use-conversation-budgets';
import type { NamingReads } from '@/lib/chat/use-naming-reads';
import type { MemberPrivilege } from '@hushbox/shared';

interface SpentFigures {
  spent: string;
  total: string;
}

interface FootFigures {
  spent: SpentFigures | null;
  funded: FundedLine | null;
}

const NO_FIGURES: FootFigures = { spent: null, funded: null };

function ownerFigures(budgets: ConversationBudgetsResponse, reads: NamingReads): FootFigures {
  const summary = budgetSummary(budgets, (row) => budgetRowName(row, reads.roster, reads.links));
  return {
    spent: { spent: summary.spent, total: summary.total },
    funded: summary.funded.length === 0 ? null : fundedLine(summary.funded),
  };
}

/**
 * A non-owner is served only their own row. A link guest's row is keyed by its member id,
 * which is the id a guest viewer carries.
 */
function memberFigures(budgets: ConversationBudgetsResponse, currentUserId: string): FootFigures {
  const row = budgets.members.find(
    (member) => member.userId === currentUserId || member.memberId === currentUserId
  );
  if (row === undefined) return NO_FIGURES;
  return {
    spent: { spent: formatBalance(row.spentNanoUsd), total: formatBalance(row.capNanoUsd) },
    funded: null,
  };
}

function SpentLine({ figures }: Readonly<{ figures: SpentFigures }>): React.JSX.Element {
  return (
    <p className="text-ui">
      <span className="text-foreground font-mono tabular-nums">{figures.spent}</span> of{' '}
      <span className="text-foreground font-mono tabular-nums">{figures.total}</span> spent
    </p>
  );
}

/**
 * The names give way on one line and the count beside them never does. Since the line
 * can cut a name at any count, a press opens the whole list under it at every count,
 * and on a mouse a hover shows the list as a tooltip.
 */
function FundedNames({ line }: Readonly<{ line: FundedLine }>): React.JSX.Element {
  const listId = React.useId();
  const isTouch = useFormFactor().pointer === 'coarse';
  const [open, setOpen] = React.useState(false);
  const [tipOpen, setTipOpen] = React.useState(false);

  const button = (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={listId}
      onClick={() => {
        setOpen((wasOpen) => !wasOpen);
      }}
      className="text-ui-sm text-muted-foreground hover:text-foreground flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm py-0.5 text-left pointer-coarse:min-h-11"
    >
      <span className="min-w-0 flex-[0_1_auto] truncate">You pay for {line.visible}</span>
      {line.more > 0 && (
        <>
          <span
            aria-hidden
            className="bg-muted text-foreground inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-xs font-semibold tabular-nums"
          >
            +{line.more}
          </span>
          <span className="sr-only">{` and ${String(line.more)} more`}</span>
        </>
      )}
      <Icon
        icon={ChevronDown}
        size="sm"
        className={cn('ml-auto transition-transform', open && 'rotate-180')}
      />
    </button>
  );

  return (
    <>
      {isTouch ? (
        button
      ) : (
        <Tooltip open={tipOpen && !open} onOpenChange={setTipOpen}>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="top">{line.full}</TooltipContent>
        </Tooltip>
      )}
      <Collapse open={open}>
        <p
          id={listId}
          data-testid={TEST_IDS.memberFundedNames}
          className="text-ui-sm text-foreground bg-muted mt-0.5 rounded-md px-2.5 py-1.5 leading-normal [overflow-wrap:anywhere]"
        >
          {line.full}
        </p>
      </Collapse>
    </>
  );
}

interface MemberSidebarFooterProps {
  conversationId: string;
  currentUserId: string;
  currentUserPrivilege: MemberPrivilege;
  collapsed: boolean;
  onBudgetSettingsClick?: (() => void) | undefined;
}

export function MemberSidebarFooter({
  conversationId,
  currentUserId,
  currentUserPrivilege,
  collapsed,
  onBudgetSettingsClick,
}: Readonly<MemberSidebarFooterProps>): React.JSX.Element {
  const headingId = React.useId();
  const isOwner = currentUserPrivilege === 'owner';
  // The budgets route is session-classed and refuses a link guest outright, so a
  // guest asks nothing: the null-conversation gate the composer's budget hook
  // already puts in front of this query
  // (`apps/web/src/hooks/billing/use-prompt-budget.ts`).
  const isLinkGuest = useLinkGuestActive();
  const { data: budgets } = useConversationBudgets(isLinkGuest ? null : conversationId);
  // The owner names the funded members, so only the owner reads the roster and the links.
  const namingReads = useNamingReads(isOwner ? conversationId : null);
  const action = isOwner ? 'Change budgets' : 'See budgets';

  if (collapsed) {
    return (
      <div className="border-sidebar-border flex justify-center border-t p-2">
        <IconButton
          icon={DollarSign}
          aria-label={action}
          data-testid={TEST_IDS.memberBudgetTrigger}
          onClick={onBudgetSettingsClick}
        />
      </div>
    );
  }

  let figures = NO_FIGURES;
  if (budgets !== undefined) {
    figures = isOwner ? ownerFigures(budgets, namingReads) : memberFigures(budgets, currentUserId);
  }

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      data-testid={TEST_IDS.memberBudgetFooter}
      className="border-sidebar-border flex shrink-0 flex-col gap-1 border-t px-4 pt-3.5 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]"
    >
      <h3
        id={headingId}
        className="text-muted-foreground pb-1 text-xs font-medium tracking-wide uppercase"
      >
        Budgets
      </h3>
      {figures.spent !== null && <SpentLine figures={figures.spent} />}
      {figures.funded !== null && <FundedNames line={figures.funded} />}
      <Button
        variant="link"
        data-testid={TEST_IDS.memberBudgetTrigger}
        onClick={onBudgetSettingsClick}
        className="text-ui mt-1.5 self-start"
      >
        {action}
      </Button>
    </div>
  );
}
