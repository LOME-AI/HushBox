import * as React from 'react';
import { flushSync } from 'react-dom';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { Button, IconButton } from '@hushbox/ui/button';
import { Check, ChevronDown, GitBranch, Pencil, Trash2, Undo2 } from '@hushbox/ui/icons';
import { Popover } from '@hushbox/ui/popover';
import { cn } from '@hushbox/ui';
import type { BranchSummary } from '@/lib/chat/branch-summary';

export interface BranchSwitcherProps {
  readonly branches: readonly BranchSummary[];
  readonly currentForkId: string | null;
  readonly onSelect: (forkId: string) => void;
  readonly onRename: (forkId: string, currentName: string) => void;
  readonly onDelete: (forkId: string) => void;
  /** From 768, the switcher stays inside this element's box. */
  readonly boundary?: HTMLElement | null | undefined;
  /** The conversation's forks in creation order; "Back to" returns to the first. */
  readonly forks?: readonly { readonly id: string; readonly name: string }[] | undefined;
  /** Held by the owner, so the thread's fork mark can open the switcher too. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

const ORDINAL_WORDS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
] as const;

function ordinal(n: number): string {
  const word = ORDINAL_WORDS[n - 1];
  if (word !== undefined) return word;
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${String(n)}${suffix}`;
}

function forkPointLabel(count: number, questionOrdinal: number): string {
  const noun = count === 1 ? 'branch' : 'branches';
  return `${String(count)} ${noun} from your ${ordinal(questionOrdinal)} question`;
}

interface ForkPointGroup {
  readonly id: string | null;
  readonly ordinal: number;
  readonly branches: readonly BranchSummary[];
}

function groupByForkPoint(branches: readonly BranchSummary[]): readonly ForkPointGroup[] {
  const groups: { id: string | null; ordinal: number; branches: BranchSummary[] }[] = [];
  for (const branch of branches) {
    const last = groups.at(-1);
    if (last?.id === branch.forkPointId) last.branches.push(branch);
    else {
      groups.push({ id: branch.forkPointId, ordinal: branch.forkPointOrdinal, branches: [branch] });
    }
  }
  return groups;
}

interface BranchRowProps {
  readonly branch: BranchSummary;
  readonly isCurrent: boolean;
  readonly onPick: () => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
}

function BranchRow({
  branch,
  isCurrent,
  onPick,
  onRename,
  onDelete,
}: Readonly<BranchRowProps>): React.JSX.Element {
  const id = React.useId();
  const nameId = `${id}-name`;
  const descriptionId = `${id}-description`;
  const hasDescription = branch.firstMessage !== '';
  // Under 16rem of list width (a popover held narrow at large text) the row's fixed parts tighten
  // so the name keeps its first word: gaps, the check's margins, and the buttons' squares. On a
  // coarse pointer the buttons keep their touch size and wrap to a line of their own under the
  // name, the first aligning its icon with the name's text.
  return (
    <div
      data-testid={TEST_ID_BUILDERS.branchRow(branch.forkId)}
      className="hover:bg-accent flex items-center gap-0.5 rounded-sm pr-0.5 @max-[16rem]/branches:gap-0 @max-[16rem]/branches:pointer-coarse:flex-wrap"
    >
      <button
        type="button"
        aria-labelledby={nameId}
        aria-describedby={hasDescription ? descriptionId : undefined}
        aria-current={isCurrent ? 'true' : undefined}
        onClick={onPick}
        className="text-foreground flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-0 pl-2 text-start @max-[16rem]/branches:gap-0.5 @max-[16rem]/branches:pl-1 @max-[16rem]/branches:pointer-coarse:basis-full"
      >
        <GitBranch
          aria-hidden="true"
          className={cn('size-4 shrink-0', isCurrent ? 'text-primary' : 'text-muted-foreground')}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span id={nameId} className="truncate font-medium">
            {branch.name}
          </span>
          {hasDescription && (
            <span
              id={descriptionId}
              className={cn(
                'text-muted-foreground line-clamp-2 text-xs leading-snug',
                isCurrent && '@max-branch-current-3line/branches:line-clamp-3'
              )}
            >
              {branch.firstMessage}
            </span>
          )}
        </span>
        {isCurrent && (
          <Check
            aria-hidden="true"
            data-branch-check=""
            className="text-primary ms-5 me-2 size-4 shrink-0 @max-[16rem]/branches:ms-1 @max-[16rem]/branches:me-0 pointer-coarse:ms-8 pointer-coarse:me-3.5 @max-[16rem]/branches:pointer-coarse:ms-1 @max-[16rem]/branches:pointer-coarse:me-0"
          />
        )}
      </button>
      <IconButton
        icon={Pencil}
        size="sm"
        aria-label={`Rename ${branch.name}`}
        data-testid={TEST_ID_BUILDERS.branchRename(branch.forkId)}
        className="text-muted-foreground hover:text-foreground @max-[16rem]/branches:size-6 @max-[16rem]/branches:pointer-coarse:ms-2 @max-[16rem]/branches:pointer-coarse:size-11"
        onClick={onRename}
      />
      <IconButton
        icon={Trash2}
        size="sm"
        aria-label={`Delete ${branch.name}`}
        data-testid={TEST_ID_BUILDERS.branchDelete(branch.forkId)}
        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 @max-[16rem]/branches:size-6 @max-[16rem]/branches:pointer-coarse:size-11"
        onClick={onDelete}
      />
    </div>
  );
}

/** One fork point's label, then its branches; a fork point not yet known draws no label. */
function ForkPointSection({
  group,
  children,
}: Readonly<{ group: ForkPointGroup; children: React.ReactNode }>): React.JSX.Element {
  const labelId = React.useId();
  if (group.ordinal === 0) return <div className="flex flex-col">{children}</div>;
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col">
      <p id={labelId} className="text-foreground px-2 py-1.5 font-medium">
        {forkPointLabel(group.branches.length, group.ordinal)}
      </p>
      {children}
    </div>
  );
}

/**
 * The conversation's branches: its trigger names the current one from 768, and its rows
 * switch, rename and delete. Below 768 it opens as a sheet titled "Branches".
 */
export function BranchSwitcher({
  branches,
  currentForkId,
  onSelect,
  onRename,
  onDelete,
  boundary,
  forks,
  open,
  onOpenChange,
}: Readonly<BranchSwitcherProps>): React.JSX.Element | null {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  // What opened the switcher when it was not its own trigger, such as the thread's fork mark;
  // read before the popover moves focus inside, as the shared overlay reads its opener.
  const openerRef = React.useRef<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    if (!open) return;
    const focused = document.activeElement;
    openerRef.current =
      focused instanceof HTMLElement && triggerRef.current?.contains(focused) !== true
        ? focused
        : null;
  }, [open]);
  const returnToOpener = React.useCallback((event: Event): void => {
    const opener = openerRef.current;
    if (!opener?.isConnected) return;
    event.preventDefault();
    opener.focus();
  }, []);
  if (branches.length < 2) return null;

  const current = branches.find((b) => b.forkId === currentForkId);
  const firstFork = forks?.[0];
  const count = new Set(branches.map((b) => b.forkId)).size;
  const close = (): void => {
    onOpenChange(false);
  };
  // A dialog returns focus to whatever held it when it opened; the row's control is gone by
  // then, so the trigger takes focus first, or below 768, where the trigger is not drawn and
  // takes none, whatever opened the switcher, and the dialog hands it back there. The close
  // commits first, so a sheet's focus trap has let go before focus leaves it.
  const closeForDialog = (): void => {
    const opener = openerRef.current;
    openerRef.current = null;
    flushSync(close);
    const trigger = triggerRef.current;
    trigger?.focus();
    if (document.activeElement !== trigger) opener?.focus();
  };

  return (
    <Popover
      title="Branches"
      width="md"
      align="start"
      boundary={boundary ?? null}
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={returnToOpener}
      data-testid={TEST_IDS.branchSwitcherMenu}
      trigger={
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          data-testid={TEST_IDS.branchSwitcher}
          aria-label={
            current === undefined
              ? `Branches: ${String(count)}`
              : `Branch: ${current.name}, ${String(count)} branches`
          }
          className="text-muted-foreground hover:text-foreground hidden max-w-60 md:inline-flex"
        >
          <GitBranch aria-hidden="true" data-branch-icon="" />
          <span className="@max-header-branch-label/app-header:hidden truncate">
            {current?.name ?? 'Branches'}
          </span>
          <ChevronDown
            aria-hidden="true"
            data-branch-chevron=""
            className="@max-header-branch-label/app-header:hidden"
          />
        </Button>
      }
    >
      <div className="@container/branches flex flex-col gap-1">
        {firstFork !== undefined && firstFork.id !== currentForkId && (
          <>
            <button
              type="button"
              onClick={() => {
                close();
                onSelect(firstFork.id);
              }}
              className="text-foreground hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-start pointer-coarse:min-h-11"
            >
              <Undo2 aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
              Back to {firstFork.name}
            </button>
            <hr className="border-border -mx-1 my-1" />
          </>
        )}
        {groupByForkPoint(branches).map((group) => (
          <ForkPointSection key={group.id ?? 'unknown'} group={group}>
            {group.branches.map((branch) => (
              <BranchRow
                key={branch.forkId}
                branch={branch}
                isCurrent={branch.forkId === currentForkId}
                onPick={() => {
                  close();
                  if (branch.forkId !== currentForkId) onSelect(branch.forkId);
                }}
                onRename={() => {
                  closeForDialog();
                  onRename(branch.forkId, branch.name);
                }}
                onDelete={() => {
                  closeForDialog();
                  onDelete(branch.forkId);
                }}
              />
            ))}
          </ForkPointSection>
        ))}
      </div>
    </Popover>
  );
}
