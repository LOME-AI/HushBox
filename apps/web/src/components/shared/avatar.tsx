import { Icon, User } from '@hushbox/ui/icons';
import type * as React from 'react';

type AvatarProps = { name: string; online?: boolean } | { person: true };

/** The first character a reader sees, so a joined emoji or an accented letter stays whole. */
function initialOf(name: string): string {
  const [first] = new Intl.Segmenter().segment(name);
  return first?.segment ?? '';
}

/**
 * A person's initial in a circle, or the person icon for the account itself. Decorative:
 * a name or a button label always carries who it is. The online ring's inner band is the
 * page colour, so the ring stands clear of the disc.
 */
export function Avatar(props: Readonly<AvatarProps>): React.JSX.Element {
  if ('person' in props) {
    return (
      <span
        aria-hidden="true"
        data-slot="avatar"
        className="bg-background-subtle text-muted-foreground inline-grid size-8 shrink-0 place-items-center rounded-full"
      >
        <Icon icon={User} />
      </span>
    );
  }
  const { name, online = false } = props;
  return (
    <span
      aria-hidden="true"
      data-slot="avatar"
      data-online={online ? '' : undefined}
      title={online ? `${name}, online` : name}
      className={
        online
          ? 'bg-secondary text-foreground inline-grid size-7 shrink-0 place-items-center rounded-full font-sans text-xs font-bold shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--success)]'
          : 'bg-secondary text-foreground inline-grid size-7 shrink-0 place-items-center rounded-full font-sans text-xs font-bold'
      }
    >
      {initialOf(name)}
    </span>
  );
}
