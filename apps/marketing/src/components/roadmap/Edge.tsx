import { motion } from 'framer-motion';
import type { RoadmapEdge, RoadmapLayout } from '@hushbox/shared';
import { quadraticArcPath } from './arc-path';
import { EDGE_DRAW_DURATION_S } from './compute-delays';

interface EdgeProps {
  readonly edge: RoadmapEdge;
  readonly positions: RoadmapLayout['positions'];
  readonly delay?: number;
}

/**
 * One edge in the constellation. Hierarchy edges are solid, dependency
 * edges are dashed and more curved. Both use a quadratic Bezier so the
 * arcs never overlap straight diagonals between distant pairs.
 *
 * Edges are `aria-hidden` because their meaning is encoded in the node
 * relationships (which screen readers can navigate via the SR-only
 * fallback list inside Constellation).
 */
export function Edge({ edge, positions, delay = 0 }: EdgeProps): React.JSX.Element | null {
  const source = positions[edge.source];
  const target = positions[edge.target];
  if (source === undefined || target === undefined) return null;

  const isDependency = edge.kind === 'dependency';
  const liftRatio = isDependency ? 0.26 : 0.12;
  const path = quadraticArcPath(source, target, liftRatio);

  if (isDependency) {
    // Dependency arcs fade in (opacity), not draw — they're cross-edges that
    // don't participate in the BFS reveal.
    return (
      <motion.path
        d={path}
        fill="none"
        data-edge-kind={edge.kind}
        data-edge-source={edge.source}
        data-edge-target={edge.target}
        className="stroke-accent/30 [stroke-dasharray:4_3]"
        strokeWidth={1}
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.5 }}
        transition={{ delay, duration: 0.3 }}
      />
    );
  }

  return (
    <motion.path
      d={path}
      fill="none"
      data-edge-kind={edge.kind}
      data-edge-source={edge.source}
      data-edge-target={edge.target}
      className="stroke-muted-foreground/40"
      strokeWidth={1.5}
      aria-hidden="true"
      initial={{ pathLength: 0 }}
      animate={{ pathLength: 1 }}
      transition={{ delay, duration: EDGE_DRAW_DURATION_S, ease: 'easeOut' }}
    />
  );
}
