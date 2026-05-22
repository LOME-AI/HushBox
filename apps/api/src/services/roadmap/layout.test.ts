import { describe, it, expect } from 'vitest';
import { computeWideLayout, computeNarrowLayout } from './layout.js';
import { normalizeRoadmap } from './normalize.js';
import { LAYOUT_CONFIG } from './layout-config.js';
import { MOCK_PROJECTS, MOCK_ISSUES } from '../linear/mock-fixtures/roadmap.js';
import type { LinearRoadmapData } from '../linear/types.js';
import type { NormalizedGraph } from './types.js';

async function fixtureGraph(): Promise<NormalizedGraph> {
  const data: LinearRoadmapData = { projects: MOCK_PROJECTS, issues: MOCK_ISSUES };
  return normalizeRoadmap(data);
}

describe('computeWideLayout', () => {
  it('produces a position for every node', async () => {
    const graph = await fixtureGraph();
    const layout = computeWideLayout(graph);
    for (const node of graph.nodes) {
      expect(layout.positions[node.id]).toBeDefined();
    }
  });

  it('is deterministic across calls (seeded RNG)', async () => {
    const graph = await fixtureGraph();
    const a = computeWideLayout(graph);
    const b = computeWideLayout(graph);
    expect(a.positions).toEqual(b.positions);
  });

  it('places in_progress projects to the left of shipped projects', async () => {
    const graph = await fixtureGraph();
    const layout = computeWideLayout(graph);
    const inProgress = graph.nodes.find((n) => n.kind === 'project' && n.status === 'in_progress');
    const shipped = graph.nodes.find((n) => n.kind === 'project' && n.status === 'shipped');
    if (inProgress === undefined || shipped === undefined) {
      throw new Error('fixture changed');
    }
    expect(layout.positions[inProgress.id]?.x).toBeLessThan(layout.positions[shipped.id]?.x ?? 0);
  });

  it('assigns the project radius to project nodes and the subtask radius to subtasks', async () => {
    const graph = await fixtureGraph();
    const layout = computeWideLayout(graph);
    const cfg = LAYOUT_CONFIG.wide;
    for (const node of graph.nodes) {
      const r = layout.positions[node.id]?.r;
      if (node.kind === 'project') expect(r).toBe(cfg.projectRadius);
      if (node.kind === 'task') expect(r).toBe(cfg.taskRadius);
      if (node.kind === 'subtask') expect(r).toBe(cfg.subtaskRadius);
    }
  });

  it('returns a viewBox that contains every node bounding circle', async () => {
    const graph = await fixtureGraph();
    const layout = computeWideLayout(graph);
    const [vbX, vbY, vbW, vbH] = layout.viewBox;
    for (const id of Object.keys(layout.positions)) {
      const p = layout.positions[id];
      if (p === undefined) continue;
      expect(p.x - p.r).toBeGreaterThanOrEqual(vbX);
      expect(p.y - p.r).toBeGreaterThanOrEqual(vbY);
      expect(p.x + p.r).toBeLessThanOrEqual(vbX + vbW);
      expect(p.y + p.r).toBeLessThanOrEqual(vbY + vbH);
    }
  });

  it('first BFS wave contains every project node', async () => {
    const graph = await fixtureGraph();
    const layout = computeWideLayout(graph);
    const projectIds = graph.nodes
      .filter((n) => n.kind === 'project')
      .map((n) => n.id)
      .sort();
    const firstWave = [...(layout.bfsOrder[0] ?? [])].sort();
    expect(firstWave).toEqual(projectIds);
  });

  it('never overlaps siblings inside their cluster (within tolerance)', async () => {
    const graph = await fixtureGraph();
    const layout = computeWideLayout(graph);
    const positions = layout.positions;
    const ids = Object.keys(positions);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = positions[ids[i] as string];
        const b = positions[ids[j] as string];
        if (a === undefined || b === undefined) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        // Allow a 1px slop because forceCollide is iterative and may leave
        // sub-pixel overlap at the last tick.
        expect(distance).toBeGreaterThanOrEqual(a.r + b.r - 1);
      }
    }
  });
});

describe('computeNarrowLayout', () => {
  it('produces a position for every node', async () => {
    const graph = await fixtureGraph();
    const layout = computeNarrowLayout(graph);
    for (const node of graph.nodes) {
      expect(layout.positions[node.id]).toBeDefined();
    }
  });

  it('is deterministic across calls', async () => {
    const graph = await fixtureGraph();
    const a = computeNarrowLayout(graph);
    const b = computeNarrowLayout(graph);
    expect(a).toEqual(b);
  });

  it('orders projects top-to-bottom: in_progress, planned, shipped', async () => {
    const graph = await fixtureGraph();
    const layout = computeNarrowLayout(graph);
    const projects = graph.nodes.filter((n) => n.kind === 'project');
    const sorted = [...projects].sort(
      (a, b) => (layout.positions[a.id]?.y ?? 0) - (layout.positions[b.id]?.y ?? 0)
    );
    const statusOrder = sorted.map((p) => p.status);
    const order: Record<string, number> = { in_progress: 0, planned: 1, shipped: 2 };
    for (let i = 1; i < statusOrder.length; i += 1) {
      expect(order[statusOrder[i] as string]).toBeGreaterThanOrEqual(
        order[statusOrder[i - 1] as string] ?? 0
      );
    }
  });

  it('indents tasks relative to their project (centerX + indent)', async () => {
    const graph = await fixtureGraph();
    const layout = computeNarrowLayout(graph);
    const cfg = LAYOUT_CONFIG.narrow;
    const tasks = graph.nodes.filter((n) => n.kind === 'task');
    for (const task of tasks) {
      expect(layout.positions[task.id]?.x).toBe(cfg.centerX + cfg.indentPx);
    }
  });

  it('indents subtasks further than tasks', async () => {
    const graph = await fixtureGraph();
    const layout = computeNarrowLayout(graph);
    const cfg = LAYOUT_CONFIG.narrow;
    const subtasks = graph.nodes.filter((n) => n.kind === 'subtask');
    for (const subtask of subtasks) {
      expect(layout.positions[subtask.id]?.x).toBe(cfg.centerX + 2 * cfg.indentPx);
    }
  });

  it('viewBox height grows to contain all positioned nodes', async () => {
    const graph = await fixtureGraph();
    const layout = computeNarrowLayout(graph);
    const maxY = Math.max(...Object.values(layout.positions).map((p) => p.y + p.r));
    expect(layout.viewBox[3]).toBeGreaterThan(maxY);
  });
});
