import * as React from 'react';
import { CheckIcon } from 'lucide-react';

import { cn } from '../../lib/utilities';
import type { MenuPresentation } from './menu-context';

/** What every kind of menu item draws. */
export interface MenuItemLook {
  icon?: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  /** A second line under the title, two lines at most. */
  description?: React.ReactNode;
  tone?: 'default' | 'danger';
  /** Greys the title and refuses the choice; the item keeps its focus, so its reason stays reachable. */
  disabled?: boolean;
  /** Shown in place of the description while the item is disabled. */
  disabledReason?: string;
  end?: React.ReactNode;
  /** Set in the check's own cell in place of the check, such as the lock on a choice refused. */
  mark?: React.ReactNode;
  /** Tighter two-line rows, for a menu of many described choices that must fit below its opener. */
  density?: 'compact';
}

/** Where a link item goes. */
export interface MenuItemLink {
  href: string;
  /** Opens in a new tab that cannot reach back into this one. */
  external?: boolean | undefined;
}

/**
 * What a link item's anchor carries, in either presentation. A disabled item carries no `href`,
 * so no click, key, middle-click or context menu has anywhere to go.
 */
function menuLinkTarget(
  link: Readonly<MenuItemLink>,
  disabled: boolean
): { href?: string; target?: '_blank'; rel?: 'noopener noreferrer' } {
  if (disabled) return {};
  return {
    href: link.href,
    ...(link.external === true && {
      target: '_blank' as const,
      rel: 'noopener noreferrer' as const,
    }),
  };
}

/** The note a row shows under its title: the disabled reason while disabled, else the description. */
function menuItemNote(look: Readonly<MenuItemLook>): React.ReactNode {
  return look.disabled === true && look.disabledReason !== undefined
    ? look.disabledReason
    : look.description;
}

/**
 * The row: one line at 2rem, two at a little more, and 2.75rem wherever a finger is the pointer.
 * A sheet is the phone's presentation, so its rows are always touch height.
 */
function menuItemClass(look: Readonly<MenuItemLook>, presentation: MenuPresentation): string {
  const danger = look.tone === 'danger';
  return cn(
    'group relative flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm font-normal outline-hidden select-none aria-disabled:cursor-not-allowed',
    menuItemNote(look) !== undefined && (look.density === 'compact' ? 'py-1.25' : 'py-1.75'),
    presentation === 'sheet'
      ? 'hover:bg-accent focus:bg-accent min-h-11 aria-disabled:hover:bg-transparent'
      : 'focus:bg-accent pointer-coarse:min-h-11',
    danger && 'text-destructive focus:bg-destructive/10',
    danger && presentation === 'sheet' && 'hover:bg-destructive/10'
  );
}

interface MenuItemIds {
  titleId: string;
  noteId: string;
}

function useMenuItemIds(): MenuItemIds {
  const id = React.useId();
  return { titleId: `${id}-title`, noteId: `${id}-note` };
}

/**
 * Names the item by its title alone and describes it by its note, so the end slot and the note
 * never join the name a role locator matches.
 */
function menuItemAria(
  look: Readonly<MenuItemLook>,
  ids: MenuItemIds
): { 'aria-labelledby': string; 'aria-describedby'?: string } {
  return {
    'aria-labelledby': ids.titleId,
    ...(menuItemNote(look) !== undefined && { 'aria-describedby': ids.noteId }),
  };
}

interface MenuItemBodyProps extends MenuItemLook {
  /** The row can be checked, so it draws the check mark; the row's `aria-checked` shows it. */
  checkable: boolean;
  ids: MenuItemIds;
}

interface StackedTextProps {
  title: React.ReactNode;
  note: React.ReactNode;
  compact: boolean;
  ids: MenuItemIds;
}

/** The title over its note, at the row's density. */
function StackedText({ title, note, compact, ids }: Readonly<StackedTextProps>): React.JSX.Element {
  return (
    <span className={cn('flex min-w-0 flex-auto flex-col', compact ? 'gap-px' : 'gap-0.5')}>
      <span
        id={ids.titleId}
        className={cn(
          'group-aria-disabled:text-disabled-ink font-medium group-aria-checked:font-semibold',
          compact && 'leading-tight'
        )}
      >
        {title}
      </span>
      {note !== undefined && (
        <span id={ids.noteId} className="text-muted-foreground line-clamp-2 text-xs leading-[1.35]">
          {note}
        </span>
      )}
    </span>
  );
}

/**
 * Icon, title, note, end slot and check, or a mark in the check's cell. With an icon the check
 * sits at the end; without one it takes the icon's place. A row that can be checked, or carries a
 * note, sets its title at 500.
 */
function MenuItemBody(props: Readonly<MenuItemBodyProps>): React.JSX.Element {
  const { icon: Icon, title, tone, end, mark, checkable, ids } = props;
  const note = menuItemNote(props);
  let check: React.ReactNode = null;
  if (mark !== undefined) {
    check = (
      <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center">
        {mark}
      </span>
    );
  } else if (checkable) {
    check = (
      <CheckIcon
        aria-hidden
        className="text-muted-foreground invisible size-4 shrink-0 stroke-[2.5] group-aria-checked:visible"
      />
    );
  }
  const iconClass = cn(
    'size-4 shrink-0',
    tone === 'danger' ? 'text-destructive' : 'text-muted-foreground'
  );

  return (
    <>
      {Icon === undefined ? check : <Icon className={iconClass} />}
      {note === undefined && !checkable ? (
        <span id={ids.titleId} className="group-aria-disabled:text-disabled-ink min-w-0 flex-auto">
          {title}
        </span>
      ) : (
        <StackedText title={title} note={note} compact={props.density === 'compact'} ids={ids} />
      )}
      {end !== undefined && (
        <span className="text-muted-foreground ml-auto text-xs tracking-widest">{end}</span>
      )}
      {Icon !== undefined && check}
    </>
  );
}

export { MenuItemBody, menuItemAria, menuItemClass, menuLinkTarget, useMenuItemIds };
export type { MenuItemIds };
