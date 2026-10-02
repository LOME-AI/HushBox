import * as React from 'react';
import { Heading, Text } from '@hushbox/ui/type';
import { TaskTree } from './TaskTree';
import { projectProgressLabel } from './compute-board';
import type { RoadmapNode } from '@hushbox/shared';
import type { FilterType, TaskWithSubtasks } from './types';

interface ProjectCardProps {
  readonly project: RoadmapNode;
  readonly tasks: readonly TaskWithSubtasks[];
  readonly activeTypes: ReadonlySet<FilterType>;
}

/**
 * One card per project. Title sits at top, then the progress in words, then
 * the task tree (with subtasks indented under their parents). When the type
 * filter hides any task or subtask in this project, a small note appears
 * before the tree, because the progress still counts work the visitor can't see.
 */
export function ProjectCard({ project, tasks, activeTypes }: ProjectCardProps): React.JSX.Element {
  const items = tasks.flatMap(({ task, subtasks }) => [task, ...subtasks]);
  const hidden = countHiddenItems(tasks, activeTypes);

  return (
    <article
      data-project-id={project.id}
      data-status={project.status}
      className="border-border bg-background-subtle/40 flex min-w-0 flex-col gap-2.5 rounded-lg border p-4 md:px-[clamp(0.75rem,calc(0.75rem_+_(100vw_-_768px)_*_0.0664),1rem)]"
    >
      <Heading level={3} variant="site-card-title" tone="ink">
        {project.title}
      </Heading>
      <Text variant="mono-sm" tone="muted">
        {projectProgressLabel(project.status, items)}
      </Text>
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
  // The type filter is a single choice, so it hides at most one type.
  if (tally.bug > 0) return { type: 'bug', count: tally.bug };
  if (tally.feature > 0) return { type: 'feature', count: tally.feature };
  return null;
}

function pluralize(type: FilterType, count: number): string {
  if (type === 'feature') return count === 1 ? 'feature' : 'features';
  return count === 1 ? 'bug' : 'bugs';
}
