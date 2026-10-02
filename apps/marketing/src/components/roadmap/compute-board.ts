import type { RoadmapNode } from '@hushbox/shared';
import type { ProjectWithTasks, RoadmapStatus, TaskWithSubtasks, TypeFilterValue } from './types';

interface BoardData {
  byStatus: Record<RoadmapStatus, ProjectWithTasks[]>;
  typeCounts: Record<TypeFilterValue, number>;
}

function appendToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

interface NodeIndex {
  tasksByProject: Map<string, RoadmapNode[]>;
  subtasksByTask: Map<string, RoadmapNode[]>;
  typeCounts: Record<TypeFilterValue, number>;
}

function indexNodes(nodes: readonly RoadmapNode[]): NodeIndex {
  const tasksByProject = new Map<string, RoadmapNode[]>();
  const subtasksByTask = new Map<string, RoadmapNode[]>();
  const typeCounts: Record<TypeFilterValue, number> = { all: 0, feature: 0, bug: 0 };
  for (const node of nodes) {
    if (node.kind === 'task' && node.parentId !== null) {
      appendToMap(tasksByProject, node.parentId, node);
    } else if (node.kind === 'subtask' && node.parentId !== null) {
      appendToMap(subtasksByTask, node.parentId, node);
    }
    if (node.kind === 'project') continue;
    typeCounts.all += 1;
    if (node.type !== null) typeCounts[node.type] += 1;
  }
  return { tasksByProject, subtasksByTask, typeCounts };
}

/**
 * Pure transform: take the flat node list from the API and build the tree shape
 * the board needs to render — projects grouped by status, each with its tasks
 * (and each task with its subtasks). Also derives the type filter's counts over
 * every task and subtask. Counts are based on the full universe, not the current
 * filter view, so the pill labels are stable as the user clicks around.
 */
export function computeBoard(nodes: readonly RoadmapNode[]): BoardData {
  const byStatus: Record<RoadmapStatus, ProjectWithTasks[]> = {
    in_progress: [],
    planned: [],
    shipped: [],
  };
  const { tasksByProject, subtasksByTask, typeCounts } = indexNodes(nodes);

  for (const node of nodes) {
    if (node.kind !== 'project') continue;
    const taskTrees: TaskWithSubtasks[] = (tasksByProject.get(node.id) ?? []).map((task) => ({
      task,
      subtasks: subtasksByTask.get(task.id) ?? [],
    }));
    byStatus[node.status].push({ project: node, tasks: taskTrees });
  }

  return { byStatus, typeCounts };
}

/**
 * A project's progress in words, over its tasks and subtasks. The API rolls a
 * parent up to its loudest child (shipped over in progress over planned), so a
 * planned project has nothing under way and a shipped one may be only partly shipped.
 */
export function projectProgressLabel(status: RoadmapStatus, items: readonly RoadmapNode[]): string {
  const total = items.length;
  const inStatus = items.filter((item) => item.status === status).length;
  if (status === 'planned') return 'Not started';
  if (status === 'shipped' && inStatus === total) return `All ${String(total)} shipped`;
  const phrase = status === 'shipped' ? 'shipped' : 'in progress';
  return `${String(inStatus)} of ${String(total)} ${phrase}`;
}

export function projectCountLabel(count: number): string {
  return `${String(count)} ${count === 1 ? 'project' : 'projects'}`;
}
