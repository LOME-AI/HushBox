import * as React from 'react';
import { ProjectCard } from './ProjectCard';
import type { ProjectWithTasks } from './types';
import type { FilterStatus, FilterType } from './use-filter-state';

interface StatusSectionProps {
  readonly status: FilterStatus;
  readonly projects: readonly ProjectWithTasks[];
  readonly activeTypes: ReadonlySet<FilterType>;
}

const STATUS_LABELS: Record<FilterStatus, string> = {
  in_progress: 'Shipping now',
  planned: 'Up next',
  shipped: 'Shipped',
};

const STATUS_DOT: Record<FilterStatus, string> = {
  in_progress: 'bg-primary',
  planned: 'bg-info',
  shipped: 'bg-success',
};

/**
 * One vertical section per status — banner with count, then a responsive
 * grid of {@link ProjectCard}s (2 columns ≥ md, 1 column otherwise). The
 * section disappears entirely when its project list is empty, which is
 * how the status filter hides "Recently shipped" without leaving a hole.
 */
export function StatusSection({
  status,
  projects,
  activeTypes,
}: StatusSectionProps): React.JSX.Element | null {
  if (projects.length === 0) return null;
  return (
    <section data-status={status} className="flex flex-col gap-4">
      <div className="border-border bg-background-subtle/60 flex items-center justify-between rounded-md border px-4 py-2">
        <h2 className="text-foreground inline-flex items-center gap-2 text-sm font-semibold tracking-[0.18em] uppercase">
          <span aria-hidden="true" className={`size-2.5 rounded-full ${STATUS_DOT[status]}`} />
          {STATUS_LABELS[status]}
        </h2>
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {projects.length} {projects.length === 1 ? 'item' : 'items'}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {projects.map(({ project, tasks }) => (
          <ProjectCard key={project.id} project={project} tasks={tasks} activeTypes={activeTypes} />
        ))}
      </div>
    </section>
  );
}

export { type ProjectWithTasks } from './types';
