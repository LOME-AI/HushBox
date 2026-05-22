import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from 'd3-force';
import { LAYOUT_CONFIG } from './layout-config.js';
import type { NormalizedEdge, NormalizedGraph, NormalizedNode, LayoutResult } from './types.js';

/**
 * Wide constellation layout. Runs a one-shot d3-force simulation to
 * convergence (no animation), pinning projects horizontally by status and
 * letting their children orbit. Cross-project dependency edges add weak
 * link forces that bend the layout without dominating.
 *
 * Determinism: a custom seeded LCG is plugged into the simulation's
 * `randomSource` so every cache miss produces the same arrangement.
 */
export function computeWideLayout(graph: NormalizedGraph): LayoutResult {
  const cfg = LAYOUT_CONFIG.wide;
  const [, , vbWidth, vbHeight] = cfg.viewBox;

  const projectByNodeId = buildProjectMap(graph.nodes);

  interface SimNode extends SimulationNodeDatum {
    id: string;
    kind: NormalizedNode['kind'];
    r: number;
  }

  const radiusFor = (kind: NormalizedNode['kind']): number => {
    if (kind === 'project') return cfg.projectRadius;
    if (kind === 'task') return cfg.taskRadius;
    return cfg.subtaskRadius;
  };

  const chargeFor = (kind: NormalizedNode['kind']): number => {
    if (kind === 'project') return cfg.projectChargeStrength;
    if (kind === 'task') return cfg.taskChargeStrength;
    return cfg.subtaskChargeStrength;
  };

  const slotX = (status: NormalizedNode['status']): number => vbWidth * cfg.slotRatios[status];

  const random = makeLcg(LAYOUT_CONFIG.seed);

  const simNodes: SimNode[] = graph.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    r: radiusFor(node.kind),
    x: vbWidth * 0.1 + random() * vbWidth * 0.8,
    y: vbHeight * 0.1 + random() * vbHeight * 0.8,
  }));

  const simNodeById = new Map(simNodes.map((n) => [n.id, n]));

  interface SimLink {
    source: string;
    target: string;
    kind: NormalizedEdge['kind'];
  }
  const simLinks: SimLink[] = graph.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
  }));

  const statusByProject = new Map<string, NormalizedNode['status']>();
  for (const node of graph.nodes) {
    if (node.kind === 'project') statusByProject.set(node.id, node.status);
  }

  const targetXFor = (simNode: SimNode): number => {
    if (simNode.kind === 'project') {
      const project = graph.nodes.find((n) => n.id === simNode.id);
      if (project === undefined) return vbWidth / 2;
      return slotX(project.status);
    }
    const projectId = projectByNodeId.get(simNode.id);
    if (projectId === undefined) return vbWidth / 2;
    const status = statusByProject.get(projectId);
    return status === undefined ? vbWidth / 2 : slotX(status);
  };

  const simulation = forceSimulation<SimNode>(simNodes)
    .randomSource(random)
    .force(
      'link',
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.id)
        .distance((link) =>
          link.kind === 'hierarchy' ? cfg.hierarchyLinkDistance : cfg.dependencyLinkDistance
        )
        .strength((link) =>
          link.kind === 'hierarchy' ? cfg.hierarchyLinkStrength : cfg.dependencyLinkStrength
        )
    )
    .force(
      'charge',
      forceManyBody<SimNode>().strength((d) => chargeFor(d.kind))
    )
    .force(
      'collide',
      forceCollide<SimNode>((d) => d.r + cfg.collidePadding)
    )
    .force('x', forceX<SimNode>((d) => targetXFor(d)).strength(cfg.centerXStrength))
    .force('y', forceY<SimNode>(vbHeight / 2).strength(cfg.centerYStrength))
    .stop();

  for (let i = 0; i < cfg.simulationTicks; i += 1) {
    simulation.tick();
  }

  const positions: Record<string, { x: number; y: number; r: number }> = {};
  for (const simNode of simNodes) {
    positions[simNode.id] = {
      x: simNode.x ?? 0,
      y: simNode.y ?? 0,
      r: simNode.r,
    };
  }
  void simNodeById;

  const viewBox = fitViewBox(positions, cfg.viewBox);
  const bfsOrder = computeBfsOrder(graph);
  return { viewBox, positions, bfsOrder };
}

/**
 * Narrow vertical layout. No simulation; projects stack top-to-bottom in
 * status order (in_progress → planned → shipped), tasks indented under
 * their project, subtasks indented again. Dependency edges are NOT laid
 * out in this view — the renderer surfaces them as count badges.
 */
export function computeNarrowLayout(graph: NormalizedGraph): LayoutResult {
  const cfg = LAYOUT_CONFIG.narrow;
  const [, , vbWidth] = cfg.viewBox;
  const positions: Record<string, { x: number; y: number; r: number }> = {};
  let y = cfg.topPadding;

  const projects = graph.nodes.filter((n) => n.kind === 'project');
  const projectOrder = orderByStatus(projects);

  const projectByNodeId = buildProjectMap(graph.nodes);
  const tasksByProject = new Map<string, NormalizedNode[]>();
  const subtasksByTask = new Map<string, NormalizedNode[]>();
  for (const node of graph.nodes) {
    if (node.kind === 'task' && node.parentId !== null) {
      const list = tasksByProject.get(node.parentId) ?? [];
      list.push(node);
      tasksByProject.set(node.parentId, list);
    } else if (node.kind === 'subtask' && node.parentId !== null) {
      const list = subtasksByTask.get(node.parentId) ?? [];
      list.push(node);
      subtasksByTask.set(node.parentId, list);
    }
  }
  void projectByNodeId;

  for (const project of projectOrder) {
    positions[project.id] = { x: cfg.centerX, y, r: cfg.projectRadius };
    y += cfg.projectSpacing;
    const tasks = tasksByProject.get(project.id) ?? [];
    for (const task of tasks) {
      positions[task.id] = {
        x: cfg.centerX + cfg.indentPx,
        y,
        r: cfg.taskRadius,
      };
      y += cfg.taskSpacing;
      const subtasks = subtasksByTask.get(task.id) ?? [];
      for (const subtask of subtasks) {
        positions[subtask.id] = {
          x: cfg.centerX + 2 * cfg.indentPx,
          y,
          r: cfg.subtaskRadius,
        };
        y += cfg.subtaskSpacing;
      }
    }
  }

  const viewBox: [number, number, number, number] = [0, 0, vbWidth, y + cfg.bottomPadding];
  const bfsOrder = computeBfsOrder(graph);
  return { viewBox, positions, bfsOrder };
}

/**
 * Build a BFS reveal order across hierarchy edges, starting from project
 * roots. Each inner array is a wave of nodes that animate in together.
 * Dependency edges are not part of the BFS traversal — they animate in
 * last as a flat group.
 */
function computeBfsOrder(graph: NormalizedGraph): string[][] {
  const children = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'hierarchy') continue;
    const list = children.get(edge.source) ?? [];
    list.push(edge.target);
    children.set(edge.source, list);
  }

  const projectIds = graph.nodes.filter((n) => n.kind === 'project').map((n) => n.id);
  if (projectIds.length === 0) return [];

  const visited = new Set<string>(projectIds);
  const waves: string[][] = [projectIds];
  let frontier = [...projectIds];

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const kids = children.get(id);
      if (kids === undefined) continue;
      for (const kid of kids) {
        if (visited.has(kid)) continue;
        visited.add(kid);
        next.push(kid);
      }
    }
    if (next.length === 0) break;
    waves.push(next);
    frontier = next;
  }
  return waves;
}

function buildProjectMap(nodes: readonly NormalizedNode[]): Map<string, string> {
  const byId = new Map<string, NormalizedNode>(nodes.map((n) => [n.id, n]));
  const result = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind === 'project') {
      result.set(node.id, node.id);
    } else if (node.kind === 'task' && node.parentId !== null) {
      result.set(node.id, node.parentId);
    } else if (node.kind === 'subtask' && node.parentId !== null) {
      const parent = byId.get(node.parentId);
      const projectId = parent?.parentId ?? null;
      if (projectId !== null) result.set(node.id, projectId);
    }
  }
  return result;
}

function orderByStatus(projects: readonly NormalizedNode[]): readonly NormalizedNode[] {
  const order: Record<NormalizedNode['status'], number> = {
    in_progress: 0,
    planned: 1,
    shipped: 2,
  };
  return [...projects].sort((a, b) => {
    const diff = order[a.status] - order[b.status];
    return diff !== 0 ? diff : a.title.localeCompare(b.title);
  });
}

function fitViewBox(
  positions: Record<string, { x: number; y: number; r: number }>,
  fallback: readonly [number, number, number, number]
): [number, number, number, number] {
  const ids = Object.keys(positions);
  if (ids.length === 0) return [...fallback];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const p = positions[id];
    if (p === undefined) continue;
    minX = Math.min(minX, p.x - p.r);
    minY = Math.min(minY, p.y - p.r);
    maxX = Math.max(maxX, p.x + p.r);
    maxY = Math.max(maxY, p.y + p.r);
  }
  const padding = 40;
  return [
    Math.floor(minX - padding),
    Math.floor(minY - padding),
    Math.ceil(maxX - minX + padding * 2),
    Math.ceil(maxY - minY + padding * 2),
  ];
}

/**
 * Seeded linear congruential generator. Produces a deterministic stream of
 * floats in [0, 1). Used both for the initial positions of simulation
 * nodes and as `simulation.randomSource`, so every layout pass on the
 * same graph produces identical coordinates.
 */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
