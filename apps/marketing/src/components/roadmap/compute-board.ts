import type { RoadmapNode } from '@hushbox/shared';
import type { ProjectWithTasks, TaskWithSubtasks } from './types';
import type { FilterStatus, FilterType } from './use-filter-state';

export interface BoardData {
  byStatus: Record<FilterStatus, ProjectWithTasks[]>;
  statusCounts: Record<FilterStatus, number>;
  typeCounts: Record<FilterType, number>;
}

/**
 * Pure transform: take the flat node list from the API and build the
 * tree shape the board needs to render — projects grouped by status,
 * each with its tasks (and each task with its subtasks). Also derives
 * the chip counts surfaced in {@link FilterChips}: total projects per
 * status and total tasks+subtasks per type. Counts are based on the
 * full universe, not the current filter view, so the chip labels are
 * stable as the user clicks around.
 */
export function computeBoard(nodes: readonly RoadmapNode[]): BoardData {
  const byStatus: Record<FilterStatus, ProjectWithTasks[]> = {
    in_progress: [],
    planned: [],
    shipped: [],
  };
  const statusCounts: Record<FilterStatus, number> = {
    in_progress: 0,
    planned: 0,
    shipped: 0,
  };
  const typeCounts: Record<FilterType, number> = { feature: 0, bug: 0 };

  const subtasksByTask = new Map<string, RoadmapNode[]>();
  const tasksByProject = new Map<string, RoadmapNode[]>();

  for (const node of nodes) {
    if (node.kind === 'task' && node.parentId !== null) {
      const list = tasksByProject.get(node.parentId) ?? [];
      list.push(node);
      tasksByProject.set(node.parentId, list);
    } else if (node.kind === 'subtask' && node.parentId !== null) {
      const list = subtasksByTask.get(node.parentId) ?? [];
      list.push(node);
      subtasksByTask.set(node.parentId, list);
    }
    if (node.kind !== 'project' && node.type !== null) {
      typeCounts[node.type] += 1;
    }
  }

  for (const node of nodes) {
    if (node.kind !== 'project') continue;
    const tasksForProject = tasksByProject.get(node.id) ?? [];
    const taskTrees: TaskWithSubtasks[] = tasksForProject.map((task) => ({
      task,
      subtasks: subtasksByTask.get(task.id) ?? [],
    }));
    byStatus[node.status].push({ project: node, tasks: taskTrees });
    statusCounts[node.status] += 1;
  }

  return { byStatus, statusCounts, typeCounts };
}
