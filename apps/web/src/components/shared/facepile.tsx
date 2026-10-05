import { cn } from '@hushbox/ui';
import { Avatar } from './avatar';
import type * as React from 'react';

const MAX_VISIBLE = 3;

type PileMembers = readonly { name: string; online: boolean }[];

// Inside the pile each disc is rimmed in the page colour so the overlaps read, and an
// online ring is thinner than a lone avatar's so it fits the rim.
const PILE_CLASS =
  'flex items-center [&>*+*]:-ml-1.5 [&>[data-slot=avatar]]:shadow-[0_0_0_2px_var(--background)] [&>[data-slot=avatar][data-online]]:shadow-[0_0_0_2px_var(--background),0_0_0_3.5px_var(--success)]';

function pileItems(members: PileMembers): React.JSX.Element {
  const overflow = members.length - MAX_VISIBLE;
  return (
    <>
      {members.slice(0, MAX_VISIBLE).map((member, index) => (
        // Members carry no id; a name may repeat, so the position disambiguates.
        <Avatar key={`${String(index)}-${member.name}`} name={member.name} online={member.online} />
      ))}
      {overflow > 0 ? (
        <span className="bg-background-subtle text-muted-foreground inline-flex h-6 items-center rounded-full px-1.5 text-xs font-medium shadow-[0_0_0_2px_var(--background)]">
          +{overflow}
        </span>
      ) : null}
    </>
  );
}

/** Three overlapping avatars then `+N`, decorative, for a control that names itself. */
export function AvatarPile({
  members,
  className,
}: Readonly<{ members: PileMembers; className?: string }>): React.JSX.Element {
  return (
    <span aria-hidden="true" className={cn(PILE_CLASS, className)}>
      {pileItems(members)}
    </span>
  );
}

type FacepileProps = Omit<
  React.ComponentProps<'button'>,
  'className' | 'style' | 'children' | 'onClick'
> & {
  members: PileMembers;
  onOpen: () => void;
};

/**
 * The members of a conversation as one button: the avatar pile drawn on the button
 * itself. On a coarse pointer a pseudo-element reaches past the row to a 2.75rem target.
 */
export function Facepile({
  members,
  onOpen,
  ...props
}: Readonly<FacepileProps>): React.JSX.Element | null {
  if (members.length === 0) return null;
  return (
    <button
      type="button"
      {...props}
      aria-label={`Members (${String(members.length)})`}
      onClick={onOpen}
      className={cn(
        'relative cursor-pointer pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2',
        PILE_CLASS
      )}
    >
      {pileItems(members)}
    </button>
  );
}
