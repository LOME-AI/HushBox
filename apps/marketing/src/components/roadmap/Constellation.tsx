import * as React from 'react';
import type { RoadmapResponse } from '@hushbox/shared';
import { Edge } from './Edge';
import { Node } from './Node';
import { computeAnimationTiming, edgeKeyFor } from './compute-delays';
import { computeRelatedSet } from './compute-relations';
import { useMediaQuery } from './use-media-query';

const SONAR_PING_DURATION_MS = 2000;

interface ConstellationProps {
  readonly data: RoadmapResponse;
  readonly layout: 'wide' | 'narrow';
  readonly visibleIds?: ReadonlySet<string> | undefined;
}

/**
 * Static constellation renderer. Animation (Lightning Fuse load,
 * Sonar Ping click) lives in dedicated hooks added later; this file
 * only renders the SVG and wires up basic click handling.
 */
export function Constellation({
  data,
  layout,
  visibleIds,
}: ConstellationProps): React.JSX.Element | null {
  const layoutData = layout === 'wide' ? data.layouts.wide : data.layouts.narrow;
  const [focusedId, setFocusedId] = React.useState<string | null>(null);

  if (layoutData === undefined) return null;

  const isNarrow = layout === 'narrow';
  const isVisible = (id: string): boolean => visibleIds === undefined || visibleIds.has(id);

  const dependencyCounts = React.useMemo<Map<string, number>>(() => {
    const counts = new Map<string, number>();
    for (const edge of data.graph.edges) {
      if (edge.kind !== 'dependency') continue;
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    }
    return counts;
  }, [data.graph.edges]);

  const timing = React.useMemo(() => computeAnimationTiming(data), [data]);
  const isTouch = useMediaQuery('(hover: none)');

  const relatedIds = React.useMemo<ReadonlySet<string> | null>(
    () => (focusedId === null ? null : computeRelatedSet(data, focusedId)),
    [data, focusedId]
  );

  const handleClick = React.useCallback((id: string): void => {
    setFocusedId((current) => (current === id ? null : id));
  }, []);

  // On touch devices Sonar Ping should fire, play, and reset on its own —
  // the user can't easily "click elsewhere" the way they would with a mouse.
  React.useEffect(() => {
    if (!isTouch || focusedId === null) return;
    const timer = setTimeout(() => setFocusedId(null), SONAR_PING_DURATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [focusedId, isTouch]);

  return (
    <div data-roadmap-constellation data-layout={layout}>
      <svg
        viewBox={layoutData.viewBox.join(' ')}
        role="graphics-document"
        aria-label="HushBox roadmap constellation"
        className="h-auto max-h-[80vh] w-full"
        data-focused-node={focusedId ?? undefined}
      >
        <g data-edges-layer aria-hidden="true">
          {data.graph.edges
            .filter((edge) => !(isNarrow && edge.kind === 'dependency'))
            .filter((edge) => isVisible(edge.source) && isVisible(edge.target))
            .map((edge) => (
              <Edge
                key={`${edge.source}-${edge.target}-${edge.kind}`}
                edge={edge}
                positions={layoutData.positions}
                delay={timing.edgeDelays[edgeKeyFor(edge.source, edge.target, edge.kind)] ?? 0}
              />
            ))}
        </g>
        <g data-nodes-layer>
          {data.graph.nodes.map((node) => {
            const position = layoutData.positions[node.id];
            if (position === undefined) return null;
            if (!isVisible(node.id)) return null;
            const dimmed = relatedIds !== null && !relatedIds.has(node.id);
            return (
              <Node
                key={node.id}
                node={node}
                position={position}
                dependencyCount={dependencyCounts.get(node.id) ?? 0}
                isNarrow={isNarrow}
                onClick={handleClick}
                delay={timing.nodeDelays[node.id] ?? 0}
                dimmed={dimmed}
              />
            );
          })}
        </g>
      </svg>
      <ul className="sr-only" aria-label="Roadmap items (text fallback)">
        {data.graph.nodes
          .filter((node) => isVisible(node.id))
          .map((node) => (
            <li key={`fallback-${node.id}`}>
              {node.kind}: {node.title} — {node.status.replace('_', ' ')}
            </li>
          ))}
      </ul>
    </div>
  );
}
