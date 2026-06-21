import * as React from 'react';
import mermaid from 'mermaid';
import { cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useTheme } from '@/providers/theme-provider';

interface MermaidDiagramProps {
  chart: string;
  className?: string;
}

// Mermaid's built-in light theme is named 'default'; 'dark' is its dark theme.
// securityLevel:'strict' sanitizes the rendered SVG (XSS mitigation) — keep it.
// `initialize` is re-run per render so a theme toggle re-themes existing
// diagrams; mermaid applies the latest config on the next `render` call.
function initializeMermaid(mode: 'light' | 'dark'): void {
  mermaid.initialize({
    startOnLoad: false,
    theme: mode === 'dark' ? 'dark' : 'default',
    securityLevel: 'strict',
  });
}

export function MermaidDiagram({
  chart,
  className,
}: Readonly<MermaidDiagramProps>): React.JSX.Element {
  const { mode } = useTheme();
  const [svg, setSvg] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const reactId = React.useId();
  const id = `mermaid-${reactId.replaceAll(':', '')}`;

  React.useEffect(() => {
    let mounted = true;

    const renderDiagram = async (): Promise<void> => {
      try {
        initializeMermaid(mode);
        const { svg: renderedSvg } = await mermaid.render(id, chart);

        if (mounted) {
          setSvg(renderedSvg);
          setError(null);
          setLoading(false);
        }
      } catch (error_) {
        if (mounted) {
          setError(error_ instanceof Error ? error_.message : 'Failed to render diagram');
          setSvg(null);
          setLoading(false);
        }
      }
    };

    void renderDiagram();

    return () => {
      mounted = false;
    };
  }, [chart, id, mode]);

  if (loading) {
    return (
      <div
        data-testid={TEST_IDS.mermaidLoading}
        className={cn('bg-muted flex items-center justify-center rounded-lg p-4', className)}
      >
        <span className="text-muted-foreground text-sm">Loading diagram...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid={TEST_IDS.mermaidDiagram}
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
      data-testid={TEST_IDS.mermaidDiagram}
      className={cn('bg-muted mx-auto max-w-full rounded-lg p-4', className)}
      dangerouslySetInnerHTML={{ __html: svg ?? '' }}
    />
  );
}
