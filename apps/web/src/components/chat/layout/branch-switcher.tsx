import * as React from 'react';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { Button, IconButton } from '@hushbox/ui/button';
import { Check, ChevronDown, GitBranch, Pencil, Trash2 } from '@hushbox/ui/icons';
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
  return (
    <div
      data-testid={TEST_ID_BUILDERS.branchRow(branch.forkId)}
      className="hover:bg-accent flex items-center gap-0.5 rounded-sm pr-0.5"
    >
      <button
        type="button"
        aria-labelledby={nameId}
        aria-describedby={hasDescription ? descriptionId : undefined}
        aria-current={isCurrent ? 'true' : undefined}
        onClick={onPick}
        className="text-foreground flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-0 pl-2 text-start"
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
            className="text-primary ms-5 me-2 size-4 shrink-0 pointer-coarse:ms-8 pointer-coarse:me-3.5"
          />
        )}
      </button>
      <IconButton
        icon={Pencil}
        size="sm"
        aria-label={`Rename ${branch.name}`}
        data-testid={TEST_ID_BUILDERS.branchRename(branch.forkId)}
        className="text-muted-foreground hover:text-foreground"
        onClick={onRename}
      />
      <IconButton
        icon={Trash2}
        size="sm"
        aria-label={`Delete ${branch.name}`}
        data-testid={TEST_ID_BUILDERS.branchDelete(branch.forkId)}
        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
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
}: Readonly<BranchSwitcherProps>): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  if (branches.length < 2) return null;

  const current = branches.find((b) => b.forkId === currentForkId);
  const count = new Set(branches.map((b) => b.forkId)).size;
  const close = (): void => {
    setOpen(false);
  };
  // A dialog returns focus to whatever held it when it opened; the row's control is gone by
  // then, so the trigger takes focus first and the dialog hands it back there.
  const closeToTrigger = (): void => {
    close();
    triggerRef.current?.focus();
  };

  return (
    <Popover
      title="Branches"
      width="md"
      align="start"
      boundary={boundary ?? null}
      open={open}
      onOpenChange={setOpen}
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
                  closeToTrigger();
                  onRename(branch.forkId, branch.name);
                }}
                onDelete={() => {
                  closeToTrigger();
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
