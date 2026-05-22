import { motion } from 'framer-motion';
import type { RoadmapNode, RoadmapLayout } from '@hushbox/shared';
import { NODE_POP_DURATION_S, PROJECT_REVEAL_DURATION_S } from './compute-delays';

interface NodeProps {
  readonly node: RoadmapNode;
  readonly position: RoadmapLayout['positions'][string];
  readonly dependencyCount: number;
  readonly isNarrow: boolean;
  readonly onClick: (id: string) => void;
  readonly delay?: number;
  readonly dimmed?: boolean;
}

/**
 * One node in the constellation. Renders as an SVG `<g>` containing a
 * circle plus a label. Projects get their explicit color; tasks and
 * subtasks tint by status (in_progress, planned, shipped) so the
 * customer can tell where each ticket sits in the lifecycle without
 * reading text.
 *
 * Type encoding uses a small letter inside the circle for the
 * accessibility tier — color is reinforced by shape per WCAG 1.4.1.
 */
export function Node({
  node,
  position,
  dependencyCount,
  isNarrow,
  onClick,
  delay = 0,
  dimmed = false,
}: NodeProps): React.JSX.Element {
  const fillClass = node.kind === 'project' ? '' : statusFillClass(node.status);
  const projectColor = node.kind === 'project' ? (node.color ?? undefined) : undefined;
  const isProject = node.kind === 'project';
  const popDuration = isProject ? PROJECT_REVEAL_DURATION_S : NODE_POP_DURATION_S;

  return (
    <motion.g
      data-node={node.id}
      data-node-kind={node.kind}
      data-node-status={node.status}
      data-node-type={node.type ?? 'none'}
      data-dimmed={dimmed ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      aria-label={`${node.kind}: ${node.title}, status ${node.status.replace('_', ' ')}`}
      onClick={() => onClick(node.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick(node.id);
        }
      }}
      className="[&:focus-visible_circle]:stroke-accent cursor-pointer focus-visible:outline-none [&:focus-visible_circle]:stroke-2"
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: dimmed ? 0.35 : 1, scale: 1 }}
      transition={{
        opacity: { duration: popDuration, delay },
        scale: { duration: popDuration, delay, ease: 'easeOut' },
      }}
      style={{ transformOrigin: `${String(position.x)}px ${String(position.y)}px` }}
    >
      <circle
        cx={position.x}
        cy={position.y}
        r={position.r}
        className={`stroke-background ${fillClass}`}
        style={projectColor !== undefined ? { fill: projectColor } : undefined}
        strokeWidth={1.5}
      />
      {node.type !== null && (
        <text
          x={position.x}
          y={position.y + 1}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-background pointer-events-none text-[9px] font-semibold"
        >
          {node.type === 'feature' ? 'F' : 'B'}
        </text>
      )}
      <text
        x={position.x + position.r + 6}
        y={position.y + 3}
        className="fill-foreground pointer-events-none text-[10px] font-medium"
      >
        {node.title}
      </text>
      {isNarrow && dependencyCount > 0 && (
        <text
          x={position.x + position.r + 6}
          y={position.y + 16}
          className="fill-foreground-muted pointer-events-none text-[9px]"
        >
          {`↬ ${String(dependencyCount)} deps`}
        </text>
      )}
    </motion.g>
  );
}

function statusFillClass(status: RoadmapNode['status']): string {
  if (status === 'in_progress') return 'fill-primary';
  if (status === 'planned') return 'fill-muted-foreground';
  return 'fill-success';
}
