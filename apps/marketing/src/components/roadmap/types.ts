import type { RoadmapNode } from '@hushbox/shared';

export interface TaskWithSubtasks {
  readonly task: RoadmapNode;
  readonly subtasks: readonly RoadmapNode[];
}

export interface ProjectWithTasks {
  readonly project: RoadmapNode;
  readonly tasks: readonly TaskWithSubtasks[];
}
