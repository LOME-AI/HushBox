import type { RoadmapNode } from '@hushbox/shared';
import type { ProjectWithTasks, TaskWithSubtasks } from './types';
import type { FilterStatus, FilterType } from './use-filter-state';

export interface BoardData {
  byStatus: Record<FilterStatus, ProjectWithTasks[]>;
  statusCounts: Record<FilterStatus, number>;
  typeCounts: Record<FilterType, number>;
}

function appendToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

interface NodeIndex {
  tasksByProject: Map<string, RoadmapNode[]>;
  subtasksByTask: Map<string, RoadmapNode[]>;
  typeCounts: Record<FilterType, number>;
}

function indexNodes(nodes: readonly RoadmapNode[]): NodeIndex {
  const tasksByProject = new Map<string, RoadmapNode[]>();
  const subtasksByTask = new Map<string, RoadmapNode[]>();
  const typeCounts: Record<FilterType, number> = { feature: 0, bug: 0 };
  for (const node of nodes) {
    if (node.kind === 'task' && node.parentId !== null) {
      appendToMap(tasksByProject, node.parentId, node);
    } else if (node.kind === 'subtask' && node.parentId !== null) {
      appendToMap(subtasksByTask, node.parentId, node);
    }
    if (node.kind !== 'project' && node.type !== null) typeCounts[node.type] += 1;
  }
  return { tasksByProject, subtasksByTask, typeCounts };
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
  const { tasksByProject, subtasksByTask, typeCounts } = indexNodes(nodes);

  for (const node of nodes) {
    if (node.kind !== 'project') continue;
    const taskTrees: TaskWithSubtasks[] = (tasksByProject.get(node.id) ?? []).map((task) => ({
      task,
      subtasks: subtasksByTask.get(task.id) ?? [],
    }));
    byStatus[node.status].push({ project: node, tasks: taskTrees });
    statusCounts[node.status] += 1;
  }

  return { byStatus, statusCounts, typeCounts };
}
