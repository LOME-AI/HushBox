import { describe, it, expect } from 'vitest';
import { computeBoard } from './compute-board';
import type { RoadmapNode } from '@hushbox/shared';

function makeProject(id: string, overrides: Partial<RoadmapNode> = {}): RoadmapNode {
  return {
    id,
    kind: 'project',
    parentId: null,
    title: `Project ${id}`,
    status: 'in_progress',
    type: null,
    progress: { done: 0, total: 0 },
    ...overrides,
  };
}

function makeTask(id: string, parentId: string, overrides: Partial<RoadmapNode> = {}): RoadmapNode {
  return {
    id,
    kind: 'task',
    parentId,
    title: `Task ${id}`,
    status: 'in_progress',
    type: 'feature',
    ...overrides,
  };
}

function makeSubtask(
  id: string,
  parentId: string,
  overrides: Partial<RoadmapNode> = {}
): RoadmapNode {
  return makeTask(id, parentId, { kind: 'subtask', ...overrides });
}

describe('computeBoard', () => {
  it('groups projects by their status', () => {
    const nodes = [
      makeProject('a00000000001', { status: 'in_progress', title: 'A' }),
      makeProject('a00000000002', { status: 'planned', title: 'B' }),
      makeProject('a00000000003', { status: 'shipped', title: 'C' }),
      makeProject('a00000000004', { status: 'in_progress', title: 'D' }),
    ];
    const board = computeBoard(nodes);
    expect(board.byStatus.in_progress.map((p) => p.project.title)).toEqual(['A', 'D']);
    expect(board.byStatus.planned.map((p) => p.project.title)).toEqual(['B']);
    expect(board.byStatus.shipped.map((p) => p.project.title)).toEqual(['C']);
  });

  it('attaches tasks to their parent project', () => {
    const nodes = [
      makeProject('a00000000001'),
      makeTask('b00000000001', 'a00000000001', { title: 'T1' }),
      makeTask('b00000000002', 'a00000000001', { title: 'T2' }),
    ];
    const board = computeBoard(nodes);
    const titles = board.byStatus.in_progress[0]?.tasks.map((t) => t.task.title);
    expect(titles).toEqual(['T1', 'T2']);
  });

  it('attaches subtasks to their parent task', () => {
    const nodes = [
      makeProject('a00000000001'),
      makeTask('b00000000001', 'a00000000001', { title: 'parent' }),
      makeSubtask('c00000000001', 'b00000000001', { title: 'kid1' }),
      makeSubtask('c00000000002', 'b00000000001', { title: 'kid2' }),
    ];
    const board = computeBoard(nodes);
    const subtaskTitles = board.byStatus.in_progress[0]?.tasks[0]?.subtasks.map((s) => s.title);
    expect(subtaskTitles).toEqual(['kid1', 'kid2']);
  });

  it('counts projects per status', () => {
    const nodes = [
      makeProject('a00000000001', { status: 'in_progress' }),
      makeProject('a00000000002', { status: 'in_progress' }),
      makeProject('a00000000003', { status: 'planned' }),
    ];
    const board = computeBoard(nodes);
    expect(board.statusCounts).toEqual({ in_progress: 2, planned: 1, shipped: 0 });
  });

  it('counts tasks and subtasks by type', () => {
    const nodes = [
      makeProject('a00000000001'),
      makeTask('b00000000001', 'a00000000001', { type: 'feature' }),
      makeTask('b00000000002', 'a00000000001', { type: 'bug' }),
      makeSubtask('c00000000001', 'b00000000001', { type: 'feature' }),
      makeSubtask('c00000000002', 'b00000000001', { type: 'bug' }),
    ];
    const board = computeBoard(nodes);
    expect(board.typeCounts).toEqual({ feature: 2, bug: 2 });
  });

  it('omits subtasks under tasks whose parent project is missing', () => {
    const nodes = [
      // Subtask under a missing task → shouldn't crash
      makeSubtask('c00000000001', 'b-missing'),
    ];
    const board = computeBoard(nodes);
    expect(board.byStatus.in_progress).toEqual([]);
  });

  it('returns empty arrays for an empty input', () => {
    const board = computeBoard([]);
    expect(board.byStatus.in_progress).toEqual([]);
    expect(board.statusCounts).toEqual({ in_progress: 0, planned: 0, shipped: 0 });
    expect(board.typeCounts).toEqual({ feature: 0, bug: 0 });
  });

  it('preserves the input order of tasks within a project', () => {
    const nodes = [
      makeProject('a00000000001'),
      makeTask('b00000000003', 'a00000000001', { title: 'third' }),
      makeTask('b00000000001', 'a00000000001', { title: 'first' }),
      makeTask('b00000000002', 'a00000000001', { title: 'second' }),
    ];
    const board = computeBoard(nodes);
    const titles = board.byStatus.in_progress[0]?.tasks.map((t) => t.task.title);
    expect(titles).toEqual(['third', 'first', 'second']);
  });
});
