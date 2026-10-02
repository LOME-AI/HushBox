import * as React from 'react';
import { cn } from '@hushbox/ui';
import { Circle, CircleCheck, Icon, RotateCw, type IconComponent } from '@hushbox/ui/icons';
import { Badge } from '@hushbox/ui/marks';
import { splitLastWord } from '../../lib/split-last-word';
import type { RoadmapNode } from '@hushbox/shared';
import type { TaskWithSubtasks } from './types';

type FilterType = NonNullable<RoadmapNode['type']>;

interface TaskTreeProps {
  readonly tasks: readonly TaskWithSubtasks[];
  readonly activeTypes: ReadonlySet<FilterType>;
}

/**
 * Render the task → subtask tree inside a project card. Tasks whose type
 * is not in the active set are hidden along with their entire subtree
 * (hierarchy wins over type filtering — a feature subtask under a hidden
 * bug task does not surface). Subtasks of a visible task that don't match
 * the type filter are simply omitted from the indented list.
 */
export function TaskTree({ tasks, activeTypes }: TaskTreeProps): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-1.5">
      {tasks.map(({ task, subtasks }) => {
        if (!isTypeVisible(task.type, activeTypes)) return null;
        const visibleSubtasks = subtasks.filter((s) => isTypeVisible(s.type, activeTypes));
        return (
          <React.Fragment key={task.id}>
            <TaskRow node={task} />
            {visibleSubtasks.map((subtask) => (
              <TaskRow key={subtask.id} node={subtask} />
            ))}
          </React.Fragment>
        );
      })}
    </ul>
  );
}

function isTypeVisible(type: RoadmapNode['type'], activeTypes: ReadonlySet<FilterType>): boolean {
  if (type === null) return true;
  return activeTypes.has(type);
}

const STATUS_GLYPH: Readonly<
  Record<RoadmapNode['status'], { icon: IconComponent; colour: string; prefix: string }>
> = {
  in_progress: { icon: RotateCw, colour: 'text-primary', prefix: 'In progress:' },
  planned: { icon: Circle, colour: 'text-info', prefix: 'Planned:' },
  shipped: { icon: CircleCheck, colour: 'text-success', prefix: 'Shipped:' },
};

function TaskRow({ node }: { readonly node: RoadmapNode }): React.JSX.Element {
  const isSubtask = node.kind === 'subtask';
  return (
    <li
      data-kind={node.kind}
      data-status={node.status}
      data-type={node.type ?? undefined}
      className={cn(
        'text-ui-snug flex min-w-0 items-start gap-2',
        isSubtask && 'border-border text-muted-foreground ml-2 border-l pl-2.5'
      )}
    >
      <StatusGlyph status={node.status} />
      <span className="min-w-0 flex-auto wrap-break-word">
        {node.type === null ? node.title : <TitleWithBadge title={node.title} type={node.type} />}
      </span>
    </li>
  );
}

/**
 * The status icon sits on the title's first line, not centred on a wrapped
 * title: a ruled exception to the rule that an icon centres on its text.
 */
function StatusGlyph({ status }: { readonly status: RoadmapNode['status'] }): React.JSX.Element {
  const { icon, colour, prefix } = STATUS_GLYPH[status];
  return (
    <span className={cn('mt-[0.05rem] inline-flex size-4 flex-none', colour)}>
      <Icon icon={icon} />
      <span className="sr-only">{prefix}</span>
    </span>
  );
}

/**
 * The title's last word and the type badge form one atomic box, so the badge
 * never starts a line alone. Inside it the pair is set as the reference sets
 * it, a real space plus a quarter rem, so it wraps exactly where the
 * reference does. Only when the pair is wider than a whole line, as at large
 * text on a phone, does the badge drop under its own word; a word wider than a
 * line breaks inside itself rather than overflowing the card.
 */
function TitleWithBadge({
  title,
  type,
}: {
  readonly title: string;
  readonly type: 'feature' | 'bug';
}): React.JSX.Element {
  const { lead, last } = splitLastWord(title);
  return (
    <>
      {lead}
      <span className="inline-flex max-w-full">
        <span className="min-w-0 wrap-anywhere">
          {last}{' '}
          <span className="ml-1 inline-flex align-[0.05rem]">
            {type === 'feature' ? (
              <Badge tone="neutral" size="compact">
                Feature
              </Badge>
            ) : (
              <Badge tone="warning" size="compact">
                Bug
              </Badge>
            )}
          </span>
        </span>
      </span>
    </>
  );
}

export { type TaskWithSubtasks } from './types';
