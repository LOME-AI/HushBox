import * as React from 'react';
import { cn } from '@hushbox/ui';
import type { RoadmapNode } from '@hushbox/shared';
import type { FilterType } from './use-filter-state';
import type { TaskWithSubtasks } from './types';

export type { TaskWithSubtasks };

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

function isTypeVisible(
  type: RoadmapNode['type'],
  activeTypes: ReadonlySet<FilterType>
): boolean {
  if (type === null) return true;
  return activeTypes.has(type);
}

function TaskRow({ node }: { readonly node: RoadmapNode }): React.JSX.Element {
  const isSubtask = node.kind === 'subtask';
  return (
    <li
      data-kind={node.kind}
      data-status={node.status}
      data-type={node.type ?? undefined}
      className={cn(
        'flex items-center gap-2 text-sm',
        isSubtask && 'ml-5 border-l border-border pl-3 text-foreground-muted'
      )}
    >
      <StatusGlyph status={node.status} />
      <span className="flex-1 truncate">{node.title}</span>
      {node.type !== null && <TypeBadge type={node.type} />}
    </li>
  );
}

function StatusGlyph({ status }: { readonly status: RoadmapNode['status'] }): React.JSX.Element {
  if (status === 'shipped') {
    return (
      <span aria-label="Shipped" className="text-success inline-flex size-4 shrink-0 items-center justify-center font-bold">
        ✓
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span aria-label="In progress" className="text-primary inline-flex size-4 shrink-0 items-center justify-center font-bold">
        ⟳
      </span>
    );
  }
  return (
    <span
      aria-label="Planned"
      className="border-info/60 inline-flex size-4 shrink-0 items-center justify-center rounded-full border-2"
    />
  );
}

function TypeBadge({ type }: { readonly type: 'feature' | 'bug' }): React.JSX.Element {
  return (
    <span
      aria-label={type}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        type === 'feature' ? 'bg-foreground/10 text-foreground' : 'bg-warning/20 text-warning'
      )}
    >
      {type === 'feature' ? 'Feature' : 'Bug'}
    </span>
  );
}
