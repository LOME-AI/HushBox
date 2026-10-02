import type { RoadmapNode } from '@hushbox/shared';

export type RoadmapStatus = RoadmapNode['status'];

export type FilterType = NonNullable<RoadmapNode['type']>;

export type TypeFilterValue = 'all' | FilterType;

export interface TaskWithSubtasks {
  readonly task: RoadmapNode;
  readonly subtasks: readonly RoadmapNode[];
}

export interface ProjectWithTasks {
  readonly project: RoadmapNode;
  readonly tasks: readonly TaskWithSubtasks[];
}
