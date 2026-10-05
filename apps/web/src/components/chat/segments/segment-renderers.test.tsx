import * as React from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRenderContext } from '@/components/chat/segments/render-context';
import type { MessageRenderFacts } from '@/components/chat/segments/render-context';
import type { ContainerKind, SegmentByKind } from '@hushbox/shared';

type SegmentRenderersModule = typeof import('@/components/chat/segments/segment-renderers');

/**
 * The markdown renderer's module, held back until a test lets it settle. Each test loads a
 * fresh copy of the renderers, so the module-wide load starts over.
 */
interface HeldRenderer {
  readonly renderers: SegmentRenderersModule;
  /** How many times the page has asked for the markdown renderer's module. */
  readonly loads: () => number;
  readonly settle: () => Promise<void>;
  readonly fail: () => Promise<void>;
}

async function holdRenderer(): Promise<HeldRenderer> {
  vi.resetModules();
  let loads = 0;
  let resolveLoad: (() => void) | undefined;
  let rejectLoad: ((error: Error) => void) | undefined;
  vi.doMock('@/components/chat/message/markdown-renderer', async () => {
    loads += 1;
    await new Promise<void>((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });
    return {
      MarkdownRenderer: ({
        content,
        extractDocuments,
      }: Readonly<{ content: string; extractDocuments?: boolean }>): React.JSX.Element => (
        <div data-testid="markdown" data-extract-documents={String(extractDocuments ?? true)}>
          {content}
        </div>
      ),
    };
  });
  const renderers = await import('@/components/chat/segments/segment-renderers');
  // The module's load runs through an async factory, so its settle waits for the
  // microtasks between the factory and the readers to drain.
  const drain = async (): Promise<void> => {
    await act(async () => {
      await renderers.loadMarkdownRenderer().catch(() => undefined);
    });
  };
  // The factory runs once the page's import reaches it, which is a few ticks after the ask.
  const asked = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(loads).toBe(1);
    });
  };
  return {
    renderers,
    loads: () => loads,
    settle: async () => {
      await asked();
      resolveLoad?.();
      await drain();
    },
    fail: async () => {
      await asked();
      rejectLoad?.(new Error('chunk failed'));
      await drain();
    },
  };
}

const FACTS: MessageRenderFacts = {
  messageId: 'm-1',
  isStreaming: false,
  modelName: 'Sonnet 4.5',
  reasoningTokens: undefined,
  reasoningEffort: undefined,
};

const TEXT: SegmentByKind['text'] = { kind: 'text', text: 'Hello there' };

function TextSegment({
  renderers,
  parent = 'root',
}: Readonly<{ renderers: SegmentRenderersModule; parent?: ContainerKind }>): React.ReactNode {
  const context = buildRenderContext([TEXT], FACTS);
  return renderers.SEGMENT_RENDERERS.text({
    node: TEXT,
    nodeKey: context.keyOf(TEXT),
    context,
    parent,
    renderChildren: () => null,
  });
}

class Boundary extends React.Component<
  Readonly<{ children: React.ReactNode }>,
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): React.ReactNode {
    return this.state.failed ? <p>render failed</p> : this.props.children;
  }
}

describe('the markdown renderer load', () => {
  let held: HeldRenderer;

  beforeEach(async () => {
    held = await holdRenderer();
  });

  it('is not ready before its module loads', () => {
    const { result } = renderHook(() => held.renderers.useMarkdownRendererReady());
    expect(result.current).toBe(false);
  });

  it('becomes ready once its module loads', async () => {
    const { result } = renderHook(() => held.renderers.useMarkdownRendererReady());
    await held.settle();
    expect(result.current).toBe(true);
  });

  it('starts as soon as the renderers module loads, before any reader asks', async () => {
    await vi.waitFor(() => {
      expect(held.loads()).toBe(1);
    });
  });

  it('hands every caller the one load', () => {
    expect(held.renderers.loadMarkdownRenderer()).toBe(held.renderers.loadMarkdownRenderer());
  });

  it('reports ready for a load a text segment started', async () => {
    render(<TextSegment renderers={held.renderers} />);
    await held.settle();
    const { result } = renderHook(() => held.renderers.useMarkdownRendererReady());
    expect(result.current).toBe(true);
  });

  it('reports ready when its module fails, so no reader waits on it forever', async () => {
    const { result } = renderHook(() => held.renderers.useMarkdownRendererReady());
    await held.fail();
    expect(result.current).toBe(true);
  });
});

describe('a text segment', () => {
  let held: HeldRenderer;

  beforeEach(async () => {
    held = await holdRenderer();
  });

  it('shows its text plain while the markdown renderer loads', () => {
    render(<TextSegment renderers={held.renderers} />);
    expect(screen.getByText('Hello there').tagName).toBe('P');
  });

  it('renders through the markdown renderer once it has loaded', async () => {
    render(<TextSegment renderers={held.renderers} />);
    await held.settle();
    expect(screen.getByTestId('markdown')).toHaveTextContent('Hello there');
  });

  it('shows reasoning text plain at the reasoning size while the markdown renderer loads', () => {
    render(<TextSegment renderers={held.renderers} parent="reasoning" />);
    expect(screen.getByText('Hello there')).not.toHaveClass('text-base');
  });

  it('mints no document from reasoning text', async () => {
    render(<TextSegment renderers={held.renderers} parent="reasoning" />);
    await held.settle();
    expect(screen.getByTestId('markdown')).toHaveAttribute('data-extract-documents', 'false');
  });

  it('renders through the markdown renderer on its first render once the module has loaded', async () => {
    renderHook(() => held.renderers.useMarkdownRendererReady());
    await held.settle();
    render(<TextSegment renderers={held.renderers} />);
    expect(screen.getByTestId('markdown')).toHaveTextContent('Hello there');
  });

  it('surfaces a markdown renderer that failed to load to its error boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <Boundary>
        <TextSegment renderers={held.renderers} />
      </Boundary>
    );
    await held.fail();
    expect(screen.getByText('render failed')).toBeInTheDocument();
  });
});
