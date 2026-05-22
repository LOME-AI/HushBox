import { describe, it, expect } from 'vitest';
import { normalizeRoadmap, hashLinearId } from './normalize.js';
import type { LinearRoadmapData } from '../linear/types.js';
import { LAYOUT_CONFIG } from './layout-config.js';

function makeData(overrides: Partial<LinearRoadmapData>): LinearRoadmapData {
  return {
    projects: [],
    issues: [],
    ...overrides,
  };
}

describe('hashLinearId', () => {
  it('returns a 12-char lowercase hex string', async () => {
    const result = await hashLinearId('linear-id-1');
    expect(result).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic for the same input', async () => {
    const a = await hashLinearId('same');
    const b = await hashLinearId('same');
    expect(a).toBe(b);
  });

  it('differs for different inputs', async () => {
    const a = await hashLinearId('input-a');
    const b = await hashLinearId('input-b');
    expect(a).not.toBe(b);
  });
});

describe('normalizeRoadmap', () => {
  it('emits an empty graph for empty input', async () => {
    const graph = await normalizeRoadmap(makeData({}));
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it('drops issues that lack a type:feature or type:bug label', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#ec4755', stateType: 'started' }],
      issues: [
        {
          id: 'i1',
          title: 'no type label',
          stateName: 'In Progress',
          stateType: 'started',
          labelNames: ['area:web'],
          parentId: null,
          projectId: 'p1',
          relations: [],
        },
      ],
    });
    const graph = await normalizeRoadmap(data);
    // Project rendered only when it contains an issue we kept; here we drop all
    // issues, so the project is not rendered either.
    expect(graph.nodes).toHaveLength(0);
  });

  it('buckets state types into the three public statuses', async () => {
    const data = makeData({
      projects: [
        { id: 'p-go', name: 'Going', color: '#000000', stateType: 'started' },
        { id: 'p-pl', name: 'Plan', color: '#000000', stateType: 'planned' },
        { id: 'p-bl', name: 'Back', color: '#000000', stateType: 'backlog' },
        { id: 'p-ps', name: 'Paus', color: '#000000', stateType: 'paused' },
        { id: 'p-do', name: 'Done', color: '#000000', stateType: 'completed' },
      ],
      issues: [
        makeFeature('i-go', 'p-go', 'started'),
        makeFeature('i-pl', 'p-pl', 'unstarted'),
        makeFeature('i-bl', 'p-bl', 'backlog'),
        makeFeature('i-ps', 'p-ps', 'unstarted'),
        makeFeature('i-do', 'p-do', 'completed'),
      ],
    });
    const graph = await normalizeRoadmap(data);
    const projectStatuses = graph.nodes
      .filter((n) => n.kind === 'project')
      .map((n) => `${n.title}=${n.status}`)
      .sort();
    expect(projectStatuses).toEqual([
      'Back=planned',
      'Done=shipped',
      'Going=in_progress',
      'Paus=planned',
      'Plan=planned',
    ]);
  });

  it('routes orphan issues into the synthetic Other project', async () => {
    const data = makeData({
      projects: [],
      issues: [
        {
          id: 'i-orph',
          title: 'no project',
          stateName: 'Todo',
          stateType: 'unstarted',
          labelNames: ['type:feature'],
          parentId: null,
          projectId: null,
          relations: [],
        },
      ],
    });
    const graph = await normalizeRoadmap(data);
    const orphanHash = await hashLinearId(LAYOUT_CONFIG.orphanProject.id);
    const orphanProject = graph.nodes.find((n) => n.id === orphanHash);
    expect(orphanProject?.title).toBe('Other');
    expect(orphanProject?.kind).toBe('project');
    const task = graph.nodes.find((n) => n.kind === 'task');
    expect(task?.parentId).toBe(orphanHash);
  });

  it('omits projects that have no surviving issues', async () => {
    const data = makeData({
      projects: [
        { id: 'p-empty', name: 'Empty', color: '#000000', stateType: 'planned' },
        { id: 'p-full', name: 'Full', color: '#000000', stateType: 'started' },
      ],
      issues: [makeFeature('i-only', 'p-full', 'started')],
    });
    const graph = await normalizeRoadmap(data);
    const projectTitles = graph.nodes.filter((n) => n.kind === 'project').map((n) => n.title);
    expect(projectTitles).toEqual(['Full']);
  });

  it('builds hierarchy edges from project to task to subtask', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [
        makeFeature('task', 'p1', 'started'),
        { ...makeFeature('sub', 'p1', 'started'), parentId: 'task' },
      ],
    });
    const graph = await normalizeRoadmap(data);
    const taskNode = graph.nodes.find((n) => n.title === 'task');
    const subNode = graph.nodes.find((n) => n.title === 'sub');
    expect(taskNode?.kind).toBe('task');
    expect(subNode?.kind).toBe('subtask');
    expect(subNode?.parentId).toBe(taskNode?.id);
    const hierarchyEdges = graph.edges.filter((e) => e.kind === 'hierarchy');
    expect(hierarchyEdges).toHaveLength(2);
  });

  it('flattens deeper-than-2 hierarchies onto the depth-1 ancestor', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [
        makeFeature('task', 'p1', 'started'),
        { ...makeFeature('sub', 'p1', 'started'), parentId: 'task' },
        { ...makeFeature('subsub', 'p1', 'started'), parentId: 'sub' },
        { ...makeFeature('subsubsub', 'p1', 'started'), parentId: 'subsub' },
      ],
    });
    const graph = await normalizeRoadmap(data);
    const taskNode = graph.nodes.find((n) => n.title === 'task');
    const deepNodes = graph.nodes.filter((n) => n.title.startsWith('subsub'));
    for (const node of deepNodes) {
      expect(node.kind).toBe('subtask');
      expect(node.parentId).toBe(taskNode?.id);
    }
  });

  it('builds dependency edges from blocks relations', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [
        {
          ...makeFeature('blocker', 'p1', 'started'),
          relations: [{ type: 'blocks', relatedIssueId: 'blocked' }],
        },
        makeFeature('blocked', 'p1', 'started'),
      ],
    });
    const graph = await normalizeRoadmap(data);
    const blocker = graph.nodes.find((n) => n.title === 'blocker');
    const blocked = graph.nodes.find((n) => n.title === 'blocked');
    const depEdges = graph.edges.filter((e) => e.kind === 'dependency');
    expect(depEdges).toHaveLength(1);
    expect(depEdges[0]?.source).toBe(blocker?.id);
    expect(depEdges[0]?.target).toBe(blocked?.id);
  });

  it('canonicalises blocked_by into the same direction as blocks', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [
        makeFeature('blocker', 'p1', 'started'),
        {
          ...makeFeature('blocked', 'p1', 'started'),
          relations: [{ type: 'blocked_by', relatedIssueId: 'blocker' }],
        },
      ],
    });
    const graph = await normalizeRoadmap(data);
    const blocker = graph.nodes.find((n) => n.title === 'blocker');
    const blocked = graph.nodes.find((n) => n.title === 'blocked');
    const depEdges = graph.edges.filter((e) => e.kind === 'dependency');
    expect(depEdges).toHaveLength(1);
    expect(depEdges[0]?.source).toBe(blocker?.id);
    expect(depEdges[0]?.target).toBe(blocked?.id);
  });

  it('deduplicates mirrored dependency relations (blocks + blocked_by between same pair)', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [
        {
          ...makeFeature('a', 'p1', 'started'),
          relations: [{ type: 'blocks', relatedIssueId: 'b' }],
        },
        {
          ...makeFeature('b', 'p1', 'started'),
          relations: [{ type: 'blocked_by', relatedIssueId: 'a' }],
        },
      ],
    });
    const graph = await normalizeRoadmap(data);
    const depEdges = graph.edges.filter((e) => e.kind === 'dependency');
    expect(depEdges).toHaveLength(1);
  });

  it('uses opaque 12-hex ids on the wire, never raw Linear ids', async () => {
    const data = makeData({
      projects: [{ id: 'p1-uuid-style', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [makeFeature('i1-uuid-style', 'p1-uuid-style', 'started')],
    });
    const graph = await normalizeRoadmap(data);
    for (const node of graph.nodes) {
      expect(node.id).toMatch(/^[0-9a-f]{12}$/);
      expect(node.id).not.toContain('-');
      expect(node.id).not.toContain('uuid');
    }
  });

  it('extracts the issue type from the label set', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [
        { ...makeFeature('feat', 'p1', 'started'), labelNames: ['type:feature'] },
        { ...makeFeature('bug', 'p1', 'started'), labelNames: ['type:bug'] },
      ],
    });
    const graph = await normalizeRoadmap(data);
    const feat = graph.nodes.find((n) => n.title === 'feat');
    const bug = graph.nodes.find((n) => n.title === 'bug');
    expect(feat?.type).toBe('feature');
    expect(bug?.type).toBe('bug');
  });

  it('never sets a color on issue nodes (only projects carry color)', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#ec4755', stateType: 'started' }],
      issues: [makeFeature('i1', 'p1', 'started')],
    });
    const graph = await normalizeRoadmap(data);
    const project = graph.nodes.find((n) => n.kind === 'project');
    const issue = graph.nodes.find((n) => n.kind === 'task');
    expect(project?.color).toBe('#ec4755');
    expect(issue?.color).toBeNull();
  });
});

function makeFeature(
  id: string,
  projectId: string | null,
  stateType: 'started' | 'unstarted' | 'completed' | 'backlog'
): import('../linear/types.js').LinearIssue {
  return {
    id,
    title: id,
    stateName: stateType,
    stateType,
    labelNames: ['type:feature'],
    parentId: null,
    projectId,
    relations: [],
  };
}
