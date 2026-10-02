import * as React from 'react';
import { Heading } from '@hushbox/ui/type';
import { ProjectCard } from './ProjectCard';
import { projectCountLabel } from './compute-board';
import type { FilterType, ProjectWithTasks, RoadmapStatus } from './types';

interface RoadmapColumnProps {
  readonly status: RoadmapStatus;
  readonly projects: readonly ProjectWithTasks[];
  readonly activeTypes: ReadonlySet<FilterType>;
}

const COLUMN_NAME: Record<RoadmapStatus, string> = {
  in_progress: 'Now',
  planned: 'Next',
  shipped: 'Shipped',
};

const COLUMN_DOT: Record<RoadmapStatus, string> = {
  in_progress: 'bg-primary',
  planned: 'bg-info',
  shipped: 'bg-success',
};

/**
 * One status column: its head, with the project count, then its project cards.
 * The count never splits; when it does not fit beside the name it moves below it.
 */
export function RoadmapColumn({
  status,
  projects,
  activeTypes,
}: RoadmapColumnProps): React.JSX.Element {
  const headId = `roadmap-column-${status}`;
  return (
    <section
      data-status={status}
      aria-labelledby={headId}
      className="flex min-w-0 flex-col gap-3.5"
    >
      <div className="border-border flex flex-wrap items-center justify-between gap-3 border-b-2 pb-2.5">
        <Heading level={2} variant="title-2" id={headId}>
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`size-2.5 shrink-0 rounded-full ${COLUMN_DOT[status]}`}
            />
            {COLUMN_NAME[status]}
          </span>
        </Heading>
        <span className="text-muted-foreground font-mono text-xs whitespace-nowrap tabular-nums">
          {projectCountLabel(projects.length)}
        </span>
      </div>
      {projects.map(({ project, tasks }) => (
        <ProjectCard key={project.id} project={project} tasks={tasks} activeTypes={activeTypes} />
      ))}
    </section>
  );
}
