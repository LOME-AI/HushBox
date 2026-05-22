import type { RoadmapResponse } from '@hushbox/shared';

/**
 * Lightning Fuse timing model. Each BFS wave fires after the previous one
 * finishes. Within a wave, all edges + nodes animate in parallel so the
 * total reveal completes in ~1.8s for the fixture-sized graphs we render
 * (≤100 nodes, ≤4 depth levels).
 *
 * Tunables are inlined here rather than in LAYOUT_CONFIG because they're
 * presentation-only and don't affect the cached layout JSON.
 */
const WAVE_DURATION_S = 0.4;
const EDGE_DRAW_DURATION_S = 0.18;
const NODE_POP_DURATION_S = 0.14;
const PROJECT_REVEAL_DURATION_S = 0.12;
const DEPENDENCY_FADE_DELAY_S = 1.5;

export interface AnimationTiming {
  edgeDelays: Record<string, number>;
  nodeDelays: Record<string, number>;
  dependencyDelay: number;
  totalDuration: number;
}

const edgeKeyFor = (source: string, target: string, kind: string): string =>
  `${source}->${target}@${kind}`;

/**
 * Compute per-element animation delays for the Lightning Fuse load. The
 * BFS order on the response defines reveal waves; this function turns that
 * into concrete delay-in-seconds values for every node and edge.
 */
export function computeAnimationTiming(data: RoadmapResponse): AnimationTiming {
  const layout = data.layouts.wide ?? data.layouts.narrow;
  const waves = layout?.bfsOrder ?? [];

  const nodeDelays: Record<string, number> = {};
  const waveOf = new Map<string, number>();

  waves.forEach((wave, waveIndex) => {
    const baseDelay = waveIndex === 0 ? 0 : waveIndex * WAVE_DURATION_S;
    for (const id of wave) {
      nodeDelays[id] = baseDelay;
      waveOf.set(id, waveIndex);
    }
  });

  // Any node missing from the BFS waves (e.g. filtered or disconnected)
  // animates in immediately to avoid "stuck invisible" bugs.
  for (const node of data.graph.nodes) {
    if (!(node.id in nodeDelays)) nodeDelays[node.id] = 0;
  }

  const edgeDelays: Record<string, number> = {};
  for (const edge of data.graph.edges) {
    if (edge.kind === 'dependency') {
      edgeDelays[edgeKeyFor(edge.source, edge.target, edge.kind)] = DEPENDENCY_FADE_DELAY_S;
      continue;
    }
    // Hierarchy edges draw together with the wave that contains their target
    // node (the target is "newly revealed"). Edge draw STARTS at the wave
    // base; the target node pops AFTER the edge finishes drawing.
    const targetWave = waveOf.get(edge.target) ?? 0;
    const baseDelay = targetWave === 0 ? 0 : targetWave * WAVE_DURATION_S;
    edgeDelays[edgeKeyFor(edge.source, edge.target, edge.kind)] = Math.max(
      baseDelay - EDGE_DRAW_DURATION_S,
      0
    );
  }

  const totalDuration =
    Math.max(waves.length - 1, 0) * WAVE_DURATION_S + NODE_POP_DURATION_S + DEPENDENCY_FADE_DELAY_S;

  return {
    edgeDelays,
    nodeDelays,
    dependencyDelay: DEPENDENCY_FADE_DELAY_S,
    totalDuration,
  };
}

export {
  EDGE_DRAW_DURATION_S,
  NODE_POP_DURATION_S,
  PROJECT_REVEAL_DURATION_S,
  WAVE_DURATION_S,
  edgeKeyFor,
};
