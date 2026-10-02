import * as React from 'react';
import mermaid from 'mermaid';
import { cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useTheme } from '@/providers/theme-provider';

interface MermaidDiagramProps {
  chart: string;
  className?: string;
  /** Holds the loading state without drawing, while the chart is not final or not yet wanted. */
  deferred?: boolean | undefined;
  /**
   * Where the drawing sits. The panel's drawing fits its pane and carries the panel diagram's
   * test ids. A drawing in the thread keeps its natural size, centred, so its labels are never
   * scaled down, and leaves the ids to its card, so a page holding both resolves each by one id.
   */
  placement?: 'panel' | 'thread' | undefined;
}

/**
 * Sets a drawn chart to its natural size, one user unit to a CSS pixel, in place of the
 * fit-to-container width mermaid gives it. The viewBox holds that size.
 */
function drawAtNaturalSize(container: HTMLElement | null): void {
  const svg = container?.querySelector(':scope > svg');
  const box = (svg?.getAttribute('viewBox') ?? '').split(/[\s,]+/);
  const width = box[2];
  const height = box[3];
  if (!svg || !width || !height) return;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
}

// Mermaid's own palette is replaced by the app's tokens. They are named as variables, never
// read into literals, so a drawing follows a theme switch or a contrast tier without redrawing.
// Rules here come after mermaid's, under the same diagram-id scope, so each one wins its match.
const BRAND_DIAGRAM_CSS = [
  '.node rect, .node path, .node .label-container, .actor, .classGroup rect, .entityBox, .stateGroup rect { fill: var(--background-paper); stroke: var(--border-strong); stroke-width: 1.25px; }',
  '.node polygon, .node polygon.label-container { fill: var(--background-subtle); stroke: var(--border-strong); stroke-width: 1.25px; }',
  '.node circle, .node ellipse, .node circle.label-container, .node ellipse.label-container { fill: var(--brand-red-subtle); stroke: var(--brand-red); stroke-width: 1.25px; }',
  '.cluster rect { fill: var(--background); stroke: var(--border); }',
  '.flowchart-link, .edgePath .path, .messageLine0, .messageLine1, .relation, .transition { stroke: var(--foreground-muted); }',
  '.arrowheadPath, .arrowMarkerPath, marker path { fill: var(--foreground-muted); stroke: var(--foreground-muted); }',
  'text, tspan, .label, .nodeLabel, .edgeLabel, .messageText, .cluster-label { fill: var(--foreground); color: var(--foreground); }',
  '.edgeLabel, .edgeLabel p, .edgeLabel rect, .labelBkg { fill: var(--background); background-color: var(--background); }',
].join('\n');

// Mermaid's built-in light theme is named 'default'; 'dark' is its dark theme.
// securityLevel:'strict' sanitizes the rendered SVG (XSS mitigation) — keep it.
// `initialize` is re-run per render so a theme toggle re-themes existing
// diagrams; mermaid applies the latest config on the next `render` call.
// The font is inherited so labels are measured and drawn in the surrounding UI face.
function initializeMermaid(mode: 'light' | 'dark'): void {
  mermaid.initialize({
    startOnLoad: false,
    theme: mode === 'dark' ? 'dark' : 'default',
    securityLevel: 'strict',
    fontFamily: 'inherit',
    themeVariables: { fontFamily: 'inherit' },
    themeCSS: BRAND_DIAGRAM_CSS,
  });
}

// Mermaid honours a chart's own `accTitle:` line; when the author gives one it
// is the best name available. Otherwise fall back to the render's `diagramType`,
// which is mermaid's internal id and carries a version suffix for some diagrams
// (verified: `graph TD` reports `flowchart-v2`), so the suffix is dropped.
function diagramLabel(chart: string, diagramType: string): string {
  const accessibleTitle = (/^[\t ]*accTitle[\t ]*:[\t ]*(.+)$/m.exec(chart)?.[1] ?? '').trim();
  if (accessibleTitle) return accessibleTitle;
  return `${diagramType.replace(/-v\d+$/, '')} diagram`;
}

export function MermaidDiagram({
  chart,
  className,
  deferred = false,
  placement = 'panel',
}: Readonly<MermaidDiagramProps>): React.JSX.Element {
  const { mode } = useTheme();
  const [svg, setSvg] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState('Diagram');
  const [hasError, setHasError] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const drawing = React.useRef<HTMLDivElement>(null);
  const inThread = placement === 'thread';
  const reactId = React.useId();
  const id = `mermaid-${reactId.replaceAll(':', '')}`;

  React.useEffect(() => {
    if (deferred) return;
    let mounted = true;

    const renderDiagram = async (): Promise<void> => {
      try {
        initializeMermaid(mode);
        const { svg: renderedSvg, diagramType: renderedType } = await mermaid.render(id, chart);

        if (mounted) {
          setSvg(renderedSvg);
          setLabel(diagramLabel(chart, renderedType));
          setHasError(false);
          setLoading(false);
        }
      } catch {
        if (mounted) {
          setHasError(true);
          setSvg(null);
          setLoading(false);
        }
      }
    };

    void renderDiagram();

    return () => {
      mounted = false;
    };
  }, [chart, id, mode, deferred]);

  // React rewrites the markup whenever this object is a new one, which would undo the
  // natural size, so it changes only with the drawing, when the size is set again.
  const markup = React.useMemo(() => ({ __html: svg ?? '' }), [svg]);

  React.useLayoutEffect(() => {
    if (inThread) drawAtNaturalSize(drawing.current);
  }, [inThread, markup]);

  if (loading) {
    return (
      <div
        data-testid={inThread ? undefined : TEST_IDS.mermaidLoading}
        className={cn('bg-muted flex items-center justify-center rounded-lg p-4', className)}
      >
        <span className="text-muted-foreground text-sm">Loading diagram...</span>
      </div>
    );
  }

  if (hasError) {
    return (
      <div
        data-testid={inThread ? undefined : TEST_IDS.mermaidDiagram}
        className={cn('bg-destructive/10 rounded-lg p-4', className)}
      >
        <span className="text-destructive text-sm">
          Could not render this diagram. Check the syntax and try again.
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid={inThread ? undefined : TEST_IDS.mermaidDiagram}
      ref={drawing}
      role="img"
      aria-label={label}
      className={cn(
        'bg-muted mx-auto max-w-full rounded-lg p-4',
        inThread && 'max-w-none [&>svg]:mx-auto',
        className
      )}
      dangerouslySetInnerHTML={markup}
    />
  );
}
