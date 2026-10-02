import { describe, it, expect } from 'vitest';
import { computeBoard, projectCountLabel, projectProgressLabel } from './compute-board';
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

  it('keeps a status with no projects as an empty column', () => {
    const board = computeBoard([makeProject('a00000000001', { status: 'planned' })]);
    expect(board.byStatus.in_progress).toEqual([]);
    expect(board.byStatus.shipped).toEqual([]);
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
    expect(board.typeCounts).toEqual({ all: 4, feature: 2, bug: 2 });
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
    expect(board.typeCounts).toEqual({ all: 0, feature: 0, bug: 0 });
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

  it('counts an untyped task under All only', () => {
    const nodes = [
      makeProject('a00000000001'),
      makeTask('b00000000001', 'a00000000001', { type: null }),
      makeTask('b00000000002', 'a00000000001', { type: 'bug' }),
    ];
    expect(computeBoard(nodes).typeCounts).toEqual({ all: 2, feature: 0, bug: 1 });
  });
});

describe('projectProgressLabel', () => {
  const statuses = (...list: RoadmapNode['status'][]): RoadmapNode[] =>
    list.map((status, index) =>
      makeTask(`b0000000000${String(index)}`, 'a00000000001', { status })
    );

  it('counts the items in progress for a project under way', () => {
    expect(
      projectProgressLabel(
        'in_progress',
        statuses('in_progress', 'in_progress', 'planned', 'in_progress')
      )
    ).toBe('3 of 4 in progress');
  });

  it('says a project in progress with one item has 1 of 1 in progress', () => {
    expect(projectProgressLabel('in_progress', statuses('in_progress'))).toBe('1 of 1 in progress');
  });

  it('says a planned project is not started', () => {
    expect(projectProgressLabel('planned', statuses('planned', 'planned'))).toBe('Not started');
  });

  it('says every item shipped when all of them are', () => {
    expect(projectProgressLabel('shipped', statuses('shipped', 'shipped', 'shipped'))).toBe(
      'All 3 shipped'
    );
  });

  it('says a one-item shipped project has all 1 shipped', () => {
    expect(projectProgressLabel('shipped', statuses('shipped'))).toBe('All 1 shipped');
  });

  it('counts the shipped items for a partly shipped project', () => {
    expect(projectProgressLabel('shipped', statuses('shipped', 'in_progress', 'planned'))).toBe(
      '1 of 3 shipped'
    );
  });
});

describe('projectCountLabel', () => {
  it('names one project in the singular', () => {
    expect(projectCountLabel(1)).toBe('1 project');
  });

  it('names several projects in the plural', () => {
    expect(projectCountLabel(2)).toBe('2 projects');
  });

  it('names an empty column in the plural', () => {
    expect(projectCountLabel(0)).toBe('0 projects');
  });
});
