import * as React from 'react';
import { cn } from '@lome-chat/ui';
import mermaid from 'mermaid';

interface MermaidDiagramProps {
  chart: string;
  className?: string;
}

// Track if mermaid has been initialized
let mermaidInitialized = false;

function initializeMermaid(): void {
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
    });
    mermaidInitialized = true;
  }
}

export function MermaidDiagram({ chart, className }: MermaidDiagramProps): React.JSX.Element {
  const [svg, setSvg] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const idRef = React.useRef(`mermaid-${Math.random().toString(36).slice(2, 11)}`);

  React.useEffect(() => {
    let mounted = true;

    const renderDiagram = async (): Promise<void> => {
      try {
        initializeMermaid();
        const { svg: renderedSvg } = await mermaid.render(idRef.current, chart);

        if (mounted) {
          setSvg(renderedSvg);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to render diagram');
          setSvg(null);
          setLoading(false);
        }
      }
    };

    void renderDiagram();

    return () => {
      mounted = false;
    };
  }, [chart]);

  if (loading) {
    return (
      <div
        data-testid="mermaid-loading"
        className={cn('bg-muted flex items-center justify-center rounded-lg p-4', className)}
      >
        <span className="text-muted-foreground text-sm">Loading diagram...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="mermaid-diagram"
        className={cn('bg-destructive/10 rounded-lg p-4', className)}
      >
        <span className="text-destructive text-sm">Failed to render diagram: {error}</span>
      </div>
    );
  }

  return (
    <div
      data-testid="mermaid-diagram"
      className={cn('bg-muted mx-auto max-w-full rounded-lg p-4', className)}
      dangerouslySetInnerHTML={{ __html: svg ?? '' }}
    />
  );
}
