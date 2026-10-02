import { cn } from '@hushbox/ui';
import { Heading } from '@hushbox/ui/type';
import type * as React from 'react';

type SettingsGroupTone = 'default' | 'attention' | 'danger';

// Every list is a size container: an inline action row reads its width from the list.
const LIST_CLASS: Readonly<Record<SettingsGroupTone, string>> = {
  default: '@container flex flex-col border-y border-border [&>*+*]:border-t [&>*+*]:border-border',
  danger:
    '@container flex flex-col border-y border-error/55 [&>*+*]:border-t [&>*+*]:border-border',
  attention:
    '@container flex flex-col rounded-lg border border-warning/45 bg-warning/6 px-4 py-1 [&>*+*]:border-t [&>*+*]:border-warning/30',
};

interface SettingsGroupProps {
  id: string;
  title: string;
  description?: React.ReactNode;
  tone?: SettingsGroupTone;
  children: React.ReactNode;
}

/** A titled list of settings rows separated by hairlines; the page's section jumps land on its id. */
export function SettingsGroup({
  id,
  title,
  description,
  tone = 'default',
  children,
}: Readonly<SettingsGroupProps>): React.JSX.Element {
  const titleId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={titleId} className="flex flex-col gap-2">
      <div
        className={cn('mb-1 flex flex-col gap-1', tone === 'danger' && '[&>h2]:text-destructive')}
      >
        <Heading level={2} variant="title-3" id={titleId}>
          {title}
        </Heading>
        {description === undefined ? null : (
          <p className="text-ui text-muted-foreground">{description}</p>
        )}
      </div>
      <div data-settings-list="" className={LIST_CLASS[tone]}>
        {children}
      </div>
    </section>
  );
}
