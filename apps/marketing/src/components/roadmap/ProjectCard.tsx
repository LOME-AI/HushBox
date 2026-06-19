import * as React from 'react';
import { ProgressBar } from './ProgressBar';
import { TaskTree } from './TaskTree';
import type { RoadmapNode } from '@hushbox/shared';
import type { TaskWithSubtasks } from './types';
import type { FilterType } from './use-filter-state';

interface ProjectCardProps {
  readonly project: RoadmapNode;
  readonly tasks: readonly TaskWithSubtasks[];
  readonly activeTypes: ReadonlySet<FilterType>;
}

/**
 * One card per project. Title sits at top, then a derived progress bar,
 * then the task tree (with subtasks indented under their parents). When
 * the type filter hides any task or subtask in this project, a small
 * note appears between the bar and the tree so visitors know the bar's
 * denominator is still counting work they can't see.
 */
export function ProjectCard({ project, tasks, activeTypes }: ProjectCardProps): React.JSX.Element {
  const progress = project.progress ?? { done: 0, total: 0 };
  const hidden = countHiddenItems(tasks, activeTypes);

  return (
    <article
      data-project-id={project.id}
      data-status={project.status}
      className="border-border bg-background-subtle/40 flex flex-col gap-3 rounded-lg border p-4"
    >
      <h3 className="text-foreground text-base font-semibold">{project.title}</h3>
      <ProgressBar done={progress.done} total={progress.total} />
      {hidden !== null && (
        <p className="text-muted-foreground text-xs italic">
          {hidden.count} {pluralize(hidden.type, hidden.count)} hidden by filter
        </p>
      )}
      <TaskTree tasks={tasks} activeTypes={activeTypes} />
    </article>
  );
}

interface HiddenSummary {
  readonly type: FilterType;
  readonly count: number;
}

function tallyHiddenInTask(
  entry: TaskWithSubtasks,
  activeTypes: ReadonlySet<FilterType>,
  tally: Record<FilterType, number>
): void {
  const { task, subtasks } = entry;
  if (task.type !== null && !activeTypes.has(task.type)) tally[task.type] += 1;
  for (const subtask of subtasks) {
    if (subtask.type !== null && !activeTypes.has(subtask.type)) tally[subtask.type] += 1;
  }
}

function countHiddenItems(
  tasks: readonly TaskWithSubtasks[],
  activeTypes: ReadonlySet<FilterType>
): HiddenSummary | null {
  const tally: Record<FilterType, number> = { feature: 0, bug: 0 };
  for (const entry of tasks) tallyHiddenInTask(entry, activeTypes, tally);
  // At most one type is filtered out at a time given the hook's auto-snap.
  if (tally.bug > 0) return { type: 'bug', count: tally.bug };
  if (tally.feature > 0) return { type: 'feature', count: tally.feature };
  return null;
}

function pluralize(type: FilterType, count: number): string {
  if (type === 'feature') return count === 1 ? 'feature' : 'features';
  return count === 1 ? 'bug' : 'bugs';
}
