import { Avatar } from './avatar';
import type * as React from 'react';

const MAX_VISIBLE = 3;

type FacepileProps = Omit<
  React.ComponentProps<'button'>,
  'className' | 'style' | 'children' | 'onClick'
> & {
  members: readonly { name: string; online: boolean }[];
  onOpen: () => void;
};

/**
 * The members of a conversation as one button: three overlapping avatars, then `+N`.
 * Inside the pile each disc is rimmed in the page colour so the overlaps read, and an
 * online ring is thinner than a lone avatar's so it fits the rim. On a coarse pointer a
 * pseudo-element reaches past the row to a 2.75rem target.
 */
export function Facepile({
  members,
  onOpen,
  ...props
}: Readonly<FacepileProps>): React.JSX.Element | null {
  if (members.length === 0) return null;
  const overflow = members.length - MAX_VISIBLE;
  return (
    <button
      type="button"
      {...props}
      aria-label={`Members (${String(members.length)})`}
      onClick={onOpen}
      className="relative flex cursor-pointer items-center pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2 [&>*+*]:-ml-1.5 [&>[data-slot=avatar]]:shadow-[0_0_0_2px_var(--background)] [&>[data-slot=avatar][data-online]]:shadow-[0_0_0_2px_var(--background),0_0_0_3.5px_var(--success)]"
    >
      {members.slice(0, MAX_VISIBLE).map((member, index) => (
        // Members carry no id; a name may repeat, so the position disambiguates.
        <Avatar key={`${String(index)}-${member.name}`} name={member.name} online={member.online} />
      ))}
      {overflow > 0 ? (
        <span className="bg-background-subtle text-muted-foreground inline-flex h-6 items-center rounded-full px-1.5 text-xs font-medium shadow-[0_0_0_2px_var(--background)]">
          +{overflow}
        </span>
      ) : null}
    </button>
  );
}
