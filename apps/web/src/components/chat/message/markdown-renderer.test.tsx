// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { MarkdownRenderer } from '@/components/chat/message/markdown-renderer';
import type { Document } from '@/lib/chat/document-parser';

const storeMock = vi.hoisted(() => ({
  setActiveDocument: vi.fn(),
  refreshActiveDocument: vi.fn(),
}));

const downloadMock = vi.hoisted(() => ({
  downloadTextFile: vi.fn<(filename: string, text: string) => void>(),
}));

vi.mock('@/lib/download-text-file', () => downloadMock);

vi.mock('@/providers/theme-provider', () => ({
  useTheme: () => ({ mode: 'light', triggerTransition: vi.fn() }),
}));

vi.mock('@/stores/document', () => ({
  useDocumentStore: () => ({
    activeDocumentId: null,
    activeDocument: null,
    setActiveDocument: storeMock.setActiveDocument,
    refreshActiveDocument: storeMock.refreshActiveDocument,
  }),
}));

/**
 * Streamdown emits its rendered nodes asynchronously, so the custom `pre`
 * element override (where all of this file's branch logic lives) only executes
 * once the parsed output reaches the DOM. Every test therefore awaits the real
 * rendered output (`findBy*` / `waitFor`) rather than asserting synchronously
 * against a tree that override has not touched yet; this helper blocks until
 * the `pre` override has produced either a DocumentCard or the `data-block`
 * clone.
 *
 * The awaiting is for the assertions, not for coverage. A coverage flake once
 * seen on this module came from a merge defect recording it under two different
 * wrapper offsets, since fixed — not from render lag under parallel load.
 */
async function awaitCodeBlockProcessed(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    const processed =
      screen.queryByTestId('document-card') !== null ||
      container.querySelector('[data-streamdown="code-block"]') !== null;
    expect(processed).toBe(true);
  });
}

describe('MarkdownRenderer error boundary', () => {
  it('renders the plain-text fallback when the markdown engine throws', async () => {
    vi.resetModules();
    vi.doMock('streamdown', () => ({
      Streamdown: () => {
        throw new Error('render blew up');
      },
    }));
    const { MarkdownRenderer: Isolated } =
      await import('@/components/chat/message/markdown-renderer');

    render(<Isolated content="Broken content" />);

    expect(await screen.findByTestId('markdown-render-fallback')).toBeInTheDocument();
    expect(await screen.findByText('Message formatting unavailable.')).toBeInTheDocument();
    expect(await screen.findByText('Broken content')).toBeInTheDocument();

    vi.doUnmock('streamdown');
    vi.resetModules();
  });
});

describe('MarkdownRenderer', () => {
  // The DOM here has no IntersectionObserver; a diagram card watches for its scroll into
  // view with one, and none of these cases scrolls, so an observer that never reports
  // leaves every diagram undrawn.
  class SilentIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly scrollMargin = '';
    readonly thresholds: readonly number[] = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', SilentIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders plain text content', async () => {
    render(<MarkdownRenderer content="Hello, world!" />);

    expect(await screen.findByText('Hello, world!')).toBeInTheDocument();
  });

  it('renders headings', async () => {
    const headingsContent = `# Heading 1

## Heading 2`;
    render(<MarkdownRenderer content={headingsContent} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Heading 1' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'Heading 2' })).toBeInTheDocument();
  });

  it('renders lists', async () => {
    const listContent = `- Item 1
- Item 2
- Item 3`;
    render(<MarkdownRenderer content={listContent} />);

    expect(await screen.findByText('Item 1')).toBeInTheDocument();
    expect(await screen.findByText('Item 2')).toBeInTheDocument();
    expect(await screen.findByText('Item 3')).toBeInTheDocument();
  });

  it('renders links behind the link-safety interstitial', async () => {
    render(<MarkdownRenderer content="[Click here](https://example.com)" />);

    const link = await screen.findByRole('button', { name: 'Click here' });
    expect(link).toBeInTheDocument();
    // No anchor means no same-tab navigation away from the conversation.
    expect(screen.queryByRole('link', { name: 'Click here' })).not.toBeInTheDocument();
  });

  it("confirms an answer's link in the app's external link dialog, the one sources use", async () => {
    const user = userEvent.setup();
    render(<MarkdownRenderer content="[Click here](https://example.com)" />);

    await user.click(await screen.findByRole('button', { name: 'Click here' }));

    // Streamdown's own modal carries the same question, so one heading means one dialog.
    expect(screen.getAllByText('Open external link?')).toHaveLength(1);
    expect(screen.getByTestId(TEST_IDS.externalLinkDialog)).toHaveTextContent(
      'https://example.com/'
    );
  });

  it('opens a confirmed link in a new tab with no referrer', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    vi.spyOn(globalThis, 'open').mockImplementation(open);
    render(<MarkdownRenderer content="[Click here](https://example.com)" />);

    await user.click(await screen.findByRole('button', { name: 'Click here' }));
    await user.click(await screen.findByRole('button', { name: 'Open link' }));

    // Streamdown's rehype-harden normalizes URLs (adds a trailing slash).
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
  });

  it('renders inline code', async () => {
    render(<MarkdownRenderer content="Use `const x = 1` in your code" />);

    expect(await screen.findByText('const x = 1')).toBeInTheDocument();
  });

  it('renders display math as KaTeX markup', async () => {
    const { container } = render(<MarkdownRenderer content={'$$E = mc^2$$'} />);

    await waitFor(() => {
      expect(container.querySelector('.katex')).toBeInTheDocument();
    });
  });

  it('renders short code blocks inline (not as document cards)', async () => {
    const codeContent = '```javascript\nconst x = 1;\n```';
    const { container } = render(<MarkdownRenderer content={codeContent} />);

    // Await the `pre` override running its default (data-block clone) path so the
    // branch is exercised deterministically; only then assert no card is shown.
    await awaitCodeBlockProcessed(container);
    expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
  });

  it('renders an empty fenced code block without a document card', async () => {
    const { container } = render(<MarkdownRenderer content={'```\n```'} />);

    await awaitCodeBlockProcessed(container);
    expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
  });

  it('renders a fenced code block with no language without a document card', async () => {
    const { container } = render(<MarkdownRenderer content={'```\nplain text\n```'} />);

    await awaitCodeBlockProcessed(container);
    expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
  });

  it('draws a mermaid document in the thread as a diagram card', async () => {
    const mermaidCode = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```';
    render(<MarkdownRenderer content={mermaidCode} />);

    const card = await screen.findByTestId(TEST_IDS.diagramCard);
    expect(card).toHaveTextContent('Graph Diagram · mermaid · 2 lines');
  });

  it('opens a mermaid document from its diagram card', async () => {
    storeMock.setActiveDocument.mockClear();
    render(<MarkdownRenderer content={'```mermaid\ngraph TD\n  A --> B\n```'} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Open' }));

    expect(storeMock.setActiveDocument).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mermaid', title: 'Graph Diagram' })
    );
  });

  it('keeps the document card for a document that is not a diagram', async () => {
    const largeCode = Array.from({ length: 15 }, (_, index) => `const line${String(index)} = 1;`);
    render(<MarkdownRenderer content={`\`\`\`typescript\n${largeCode.join('\n')}\n\`\`\``} />);

    expect(await screen.findByTestId('document-card')).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.diagramCard)).not.toBeInTheDocument();
  });

  it('renders large code blocks (15+ lines) as document cards', async () => {
    const largeCode = Array.from({ length: 15 })
      .fill(null)
      .map((_, index) => `const line${String(index)} = ${String(index)};`)
      .join('\n');
    const content = `\`\`\`typescript\n${largeCode}\n\`\`\``;
    render(<MarkdownRenderer content={content} />);

    // Large code blocks are extracted as documents and show a card
    // extractTitle detects "const line0" → title "line0"
    expect(await screen.findByTestId('document-card')).toBeInTheDocument();
    expect(await screen.findByText('line0')).toBeInTheDocument();
  });

  it('does not extract code blocks with fewer than 15 lines as documents', async () => {
    const shortCode = Array.from({ length: 14 })
      .fill(null)
      .map((_, index) => `const line${String(index)} = ${String(index)};`)
      .join('\n');
    const content = `\`\`\`typescript\n${shortCode}\n\`\`\``;
    const { container } = render(<MarkdownRenderer content={content} />);

    await awaitCodeBlockProcessed(container);
    expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
  });

  describe('document extraction off', () => {
    it('renders a document-sized code block as code rather than a card', async () => {
      const largeCode = Array.from({ length: 15 })
        .fill(null)
        .map((_, index) => `const line${String(index)} = ${String(index)};`)
        .join('\n');
      const content = `\`\`\`typescript\n${largeCode}\n\`\`\``;
      const { container } = render(<MarkdownRenderer content={content} extractDocuments={false} />);

      await awaitCodeBlockProcessed(container);
      expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
    });

    it('renders a mermaid fence as a diagram rather than a card', async () => {
      const mermaidCode = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```';
      render(<MarkdownRenderer content={mermaidCode} extractDocuments={false} />);

      // The mermaid plugin's own output carries no stable hook to wait on, so
      // absence is established over `findBy`'s timeout rather than after a
      // marker element.
      await expect(screen.findByTestId('document-card')).rejects.toThrow();
    });
  });

  describe('code block header', () => {
    const FENCE = '```rust\nfn main() {\n    println!("hi");\n}\n```';
    const FENCED_CODE = 'fn main() {\n    println!("hi");\n}\n';

    // Streamdown still renders its own header, hidden by the block's styles, so the
    // language is read from the header that holds the block's controls.
    const headerOf = async (container: HTMLElement): Promise<HTMLElement | null> => {
      await awaitCodeBlockProcessed(container);
      const download = await screen.findByRole('button', { name: 'Download' });
      return download.closest('div');
    };

    beforeEach(() => {
      downloadMock.downloadTextFile.mockReset();
    });

    it("names the block's language in its header", async () => {
      const { container } = render(<MarkdownRenderer content={FENCE} />);
      await awaitCodeBlockProcessed(container);

      expect(await headerOf(container)).toHaveTextContent(/^rust/);
    });

    it('names a language the way the fence spells it', async () => {
      const { container } = render(<MarkdownRenderer content={'```c++\nint x;\n```'} />);
      await awaitCodeBlockProcessed(container);

      expect(await headerOf(container)).toHaveTextContent(/^c\+\+/);
    });

    it('labels its download control with the word Download', async () => {
      const { container } = render(<MarkdownRenderer content={FENCE} />);
      await awaitCodeBlockProcessed(container);

      expect(await screen.findByRole('button', { name: 'Download' })).toHaveTextContent('Download');
    });

    it('labels its copy control with the word Copy', async () => {
      const { container } = render(<MarkdownRenderer content={FENCE} />);
      await awaitCodeBlockProcessed(container);

      expect(await screen.findByRole('button', { name: 'Copy' })).toHaveTextContent('Copy');
    });

    it('offers a single download control per block', async () => {
      const { container } = render(<MarkdownRenderer content={FENCE} />);
      await awaitCodeBlockProcessed(container);

      expect(await screen.findAllByRole('button', { name: /download/i })).toHaveLength(1);
    });

    it('offers a single copy control per block', async () => {
      const { container } = render(<MarkdownRenderer content={FENCE} />);
      await awaitCodeBlockProcessed(container);

      expect(await screen.findAllByRole('button', { name: /copy/i })).toHaveLength(1);
    });

    it("copies the block's code without its line numbers", async () => {
      const user = userEvent.setup();
      const { container } = render(<MarkdownRenderer content={FENCE} />);
      await awaitCodeBlockProcessed(container);

      await user.click(await screen.findByRole('button', { name: 'Copy' }));

      expect(await navigator.clipboard.readText()).toBe(FENCED_CODE);
    });

    it("downloads the block's code without its line numbers", async () => {
      const user = userEvent.setup();
      const { container } = render(<MarkdownRenderer content={FENCE} />);
      await awaitCodeBlockProcessed(container);

      await user.click(await screen.findByRole('button', { name: 'Download' }));

      expect(downloadMock.downloadTextFile).toHaveBeenCalledWith('file.rs', FENCED_CODE);
    });

    it('downloads a block with no language as a text file', async () => {
      const user = userEvent.setup();
      const { container } = render(<MarkdownRenderer content={'```\nplain text\n```'} />);
      await awaitCodeBlockProcessed(container);

      await user.click(await screen.findByRole('button', { name: 'Download' }));

      expect(downloadMock.downloadTextFile).toHaveBeenCalledWith('file.txt', 'plain text\n');
    });

    it('numbers each line from a counter drawn outside the text', async () => {
      const { container } = render(<MarkdownRenderer content={FENCE} />);
      await awaitCodeBlockProcessed(container);

      await waitFor(() => {
        const lines = container.querySelectorAll('[data-streamdown="code-block-body"] code > span');
        expect(lines).toHaveLength(3);
        for (const line of lines) {
          expect(line.className).toContain('before:content-[counter(line)]');
          expect(line.className).toContain('before:select-none');
        }
      });
    });

    it('keeps a mermaid diagram on its own controls when documents are off', async () => {
      const { container } = render(
        <MarkdownRenderer
          content={'```mermaid\ngraph TD\n  A --> B\n```'}
          extractDocuments={false}
        />
      );

      await waitFor(() => {
        expect(container.querySelector('[data-streamdown="mermaid-block"]')).not.toBeNull();
      });
      expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    });
  });

  describe('code block colours', () => {
    const TS_FENCE = [
      '```ts',
      '// greets the caller',
      'function greet(name: string): string {',
      "  return 'hi ' + name + 1;",
      '}',
      '```',
    ].join('\n');

    // Streamdown hands each highlighted token its light colour as `--sdm-c` and its dark
    // colour as `--shiki-dark`, both inline on the token's span. Until the highlighter
    // answers, each line is one token coloured `inherit`. A colour that is a bare variable
    // is read through to the value the block's frame gives that variable, since that is
    // the colour the token paints in.
    const throughFrame = (container: HTMLElement, colour: string): string => {
      const variable = /^var\((--[a-z-]+)\)$/.exec(colour)?.[1];
      if (variable === undefined) return colour;
      const frame = container.querySelector<HTMLElement>(
        '[data-streamdown="code-block"]'
      )?.parentElement;
      return frame?.style.getPropertyValue(variable) ?? '';
    };

    const tokenColoursOf = async (
      container: HTMLElement,
      text: string
    ): Promise<{ light: string; dark: string }> => {
      await awaitCodeBlockProcessed(container);
      let token: HTMLElement | undefined;
      await waitFor(() => {
        token = [
          ...container.querySelectorAll<HTMLElement>(
            '[data-streamdown="code-block-body"] code > span > span'
          ),
        ].find((span) => span.textContent === text);
        expect(token?.style.getPropertyValue('--sdm-c')).not.toMatch(/^(inherit)?$/);
      });
      return {
        light: throughFrame(container, token?.style.getPropertyValue('--sdm-c') ?? ''),
        dark: throughFrame(container, token?.style.getPropertyValue('--shiki-dark') ?? ''),
      };
    };

    it.each([
      ['comment', '// greets the caller'],
      ['keyword', 'function'],
      ['function', 'greet'],
      ['string-expression', "'hi '"],
      ['constant', '1'],
    ])("paints a %s in the light theme from the app's code palette", async (kind, text) => {
      const { container } = render(<MarkdownRenderer content={TS_FENCE} />);

      const { light } = await tokenColoursOf(container, text);

      expect(light).toBe(`var(--code-${kind})`);
    });

    it.each([
      ['comment', '// greets the caller'],
      ['keyword', 'function'],
      ['function', 'greet'],
      ['string-expression', "'hi '"],
      ['constant', '1'],
    ])("paints a %s in the dark theme from the app's code palette", async (kind, text) => {
      const { container } = render(<MarkdownRenderer content={TS_FENCE} />);

      const { dark } = await tokenColoursOf(container, text);

      expect(dark).toBe(`var(--code-${kind})`);
    });

    it("paints text no token kind claims in the page's foreground", async () => {
      const { container } = render(<MarkdownRenderer content={'```ts\nlet x;\n```'} />);

      const { light } = await tokenColoursOf(container, ' x;');

      expect(light).toBe('var(--foreground)');
    });

    it('draws the code on the muted fill', async () => {
      const { container } = render(<MarkdownRenderer content={TS_FENCE} />);
      await awaitCodeBlockProcessed(container);

      const frame = container.querySelector('[data-streamdown="code-block"]')?.parentElement;

      expect(frame).toHaveClass('bg-muted');
      expect(frame).not.toHaveClass('bg-background');
    });
  });

  describe('streaming state', () => {
    const codeLines = (count: number): string =>
      Array.from({ length: count })
        .fill(null)
        .map((_, index) => `const line${String(index)} = ${String(index)};`)
        .join('\n');

    const jsxLines = codeLines(15);

    const openDocument = async (): Promise<Document> => {
      await userEvent.click(await screen.findByTestId('document-card'));
      const call = storeMock.setActiveDocument.mock.calls.at(-1);
      expect(call).toBeDefined();
      return call?.[0] as Document;
    };

    beforeEach(() => {
      storeMock.setActiveDocument.mockClear();
    });

    it('marks a document from a still-streaming message as streaming', async () => {
      render(<MarkdownRenderer content={`\`\`\`jsx\n${jsxLines}\n\`\`\``} isStreaming />);

      const opened = await openDocument();
      expect(opened.isStreaming).toBe(true);
    });

    it('marks a document from a settled message as not streaming', async () => {
      render(<MarkdownRenderer content={`\`\`\`jsx\n${jsxLines}\n\`\`\``} isStreaming={false} />);

      const opened = await openDocument();
      expect(opened.isStreaming).toBe(false);
    });

    it('marks a block whose fence never closed by its message, not by its text', async () => {
      // The document is half-written either way; only the message says whether
      // more of it is still coming.
      render(<MarkdownRenderer content={`\`\`\`jsx\n${jsxLines}`} isStreaming />);

      const opened = await openDocument();
      expect(opened.isStreaming).toBe(true);
    });

    it('marks a mermaid diagram from a still-streaming message as streaming', async () => {
      render(<MarkdownRenderer content={'```mermaid\ngraph TD\n  A --> B'} isStreaming />);

      const opened = await openDocument();
      expect(opened.isStreaming).toBe(true);
    });

    it('treats a message with no streaming state as settled', async () => {
      render(<MarkdownRenderer content={`\`\`\`jsx\n${jsxLines}\n\`\`\``} />);

      const opened = await openDocument();
      expect(opened.isStreaming).toBe(false);
    });
  });

  it('renders bold and italic text', async () => {
    render(<MarkdownRenderer content="**bold** and *italic* text" />);

    expect(await screen.findByText('bold')).toBeInTheDocument();
    expect(await screen.findByText('italic')).toBeInTheDocument();
  });

  it('renders tables (GFM)', async () => {
    const table = `| Name | Age |
| --- | --- |
| John | 30 |
| Jane | 25 |`;

    render(<MarkdownRenderer content={table} />);

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(await screen.findByText('Name')).toBeInTheDocument();
    expect(await screen.findByText('John')).toBeInTheDocument();
  });

  it('renders strikethrough (GFM)', async () => {
    render(<MarkdownRenderer content="~~deleted~~" />);

    const deletedText = await screen.findByText('deleted');
    expect(deletedText.tagName.toLowerCase()).toBe('del');
  });

  it('handles empty content gracefully', async () => {
    render(<MarkdownRenderer content="" />);

    const container = await screen.findByTestId('markdown-renderer');
    expect(container).toBeInTheDocument();
  });

  it('applies custom className', async () => {
    render(<MarkdownRenderer content="Test" className="custom-class" />);

    // Await the parsed content so the render is settled before asserting.
    expect(await screen.findByText('Test')).toBeInTheDocument();
    expect(screen.getByTestId('markdown-renderer')).toHaveClass('custom-class');
  });

  it('renders blockquotes', async () => {
    render(<MarkdownRenderer content="> This is a quote" />);

    expect(await screen.findByText('This is a quote')).toBeInTheDocument();
  });

  it('handles malformed markdown gracefully', async () => {
    const malformed = '```javascript\nconst x = 1';
    const { container } = render(<MarkdownRenderer content={malformed} />);

    // An unterminated fence is still parsed into a code block, so wait for the
    // `pre` override to process it before asserting the container is intact.
    await awaitCodeBlockProcessed(container);
    expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
  });

  describe('link styling', () => {
    it('renders links inside the scope that recolours them brand-red', async () => {
      render(<MarkdownRenderer content="See [the docs](https://example.com) for help" />);

      const link = await screen.findByRole('button', { name: 'the docs' });
      const wrapper = screen.getByTestId('markdown-renderer');
      // The colour rides a descendant selector on the wrapper rather than an
      // inline style, so what has to hold is that the element Streamdown
      // renders is the one that selector reaches.
      expect(wrapper.className).toContain('[&_[data-streamdown=link]]:text-brand-red');
      expect(wrapper.querySelector('[data-streamdown="link"]')).toBe(link);
    });
  });

  describe('document type detection', () => {
    it('detects html code blocks as html type', async () => {
      const htmlCode = Array.from({ length: 15 })
        .fill(null)
        .map((_, index) => `<div>Line ${String(index)}</div>`)
        .join('\n');
      const content = `\`\`\`html\n${htmlCode}\n\`\`\``;

      render(<MarkdownRenderer content={content} />);

      const card = await screen.findByTestId('document-card');
      expect(card).toBeInTheDocument();
      // Card aria-label includes the document title (language display name for untitled blocks)
      expect(card).toHaveAttribute('aria-label', 'Open HTML');
    });

    it('does not extract code blocks without a language as documents', async () => {
      const noLangCode = Array.from({ length: 20 })
        .fill(null)
        .map((_, index) => `line ${String(index)}`)
        .join('\n');
      const content = `\`\`\`\n${noLangCode}\n\`\`\``;

      const { container } = render(<MarkdownRenderer content={content} />);

      await awaitCodeBlockProcessed(container);
      expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
    });

    it('detects unknown language with 15+ lines as code type', async () => {
      const goCode = Array.from({ length: 15 })
        .fill(null)
        .map((_, index) => `fmt.Println(${String(index)})`)
        .join('\n');
      const content = `\`\`\`go\n${goCode}\n\`\`\``;

      render(<MarkdownRenderer content={content} />);

      const card = await screen.findByTestId('document-card');
      expect(card).toBeInTheDocument();
      expect(await screen.findByText('Go')).toBeInTheDocument();
    });

    it('detects tsx code blocks as react type', async () => {
      const tsxCode = Array.from({ length: 15 })
        .fill(null)
        .map((_, index) => `const Component${String(index)} = () => <div />;`)
        .join('\n');
      const content = `\`\`\`tsx\n${tsxCode}\n\`\`\``;

      render(<MarkdownRenderer content={content} />);

      const card = await screen.findByTestId('document-card');
      expect(card).toBeInTheDocument();
      expect(await screen.findByText(/tsx/i)).toBeInTheDocument();
    });

    it('generates stable document IDs for identical content', async () => {
      const mermaidCode = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```';

      const { rerender } = render(<MarkdownRenderer content={mermaidCode} />);

      expect(await screen.findByTestId('document-card')).toBeInTheDocument();

      // Re-render with same content — card should still be there with same stable ID
      rerender(<MarkdownRenderer content={mermaidCode} />);

      expect(await screen.findByTestId('document-card')).toBeInTheDocument();
    });
  });
});
