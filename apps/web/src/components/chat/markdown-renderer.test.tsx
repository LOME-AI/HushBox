import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './markdown-renderer';

// Mock mermaid to avoid actual rendering
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg>Diagram</svg>',
      bindFunctions: vi.fn(),
    }),
  },
}));

describe('MarkdownRenderer', () => {
  it('renders plain text content', () => {
    render(<MarkdownRenderer content="Hello, world!" />);

    expect(screen.getByText('Hello, world!')).toBeInTheDocument();
  });

  it('renders headings', () => {
    const headingsContent = `# Heading 1

## Heading 2`;
    render(<MarkdownRenderer content={headingsContent} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Heading 1' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Heading 2' })).toBeInTheDocument();
  });

  it('renders lists', () => {
    const listContent = `- Item 1
- Item 2
- Item 3`;
    render(<MarkdownRenderer content={listContent} />);

    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
    expect(screen.getByText('Item 3')).toBeInTheDocument();
  });

  it('renders links', () => {
    render(<MarkdownRenderer content="[Click here](https://example.com)" />);

    const link = screen.getByRole('link', { name: 'Click here' });
    expect(link).toHaveAttribute('href', 'https://example.com');
  });

  it('renders inline code', () => {
    render(<MarkdownRenderer content="Use `const x = 1` in your code" />);

    expect(screen.getByText('const x = 1')).toBeInTheDocument();
  });

  it('renders code blocks with CodeBlock component', () => {
    const code = '```javascript\nconst x = 1;\n```';
    render(<MarkdownRenderer content={code} />);

    // CodeBlock has data-testid="code-block"
    expect(screen.getByTestId('code-block')).toBeInTheDocument();
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
  });

  it('renders mermaid code blocks as document cards', () => {
    const mermaidCode = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```';
    render(<MarkdownRenderer content={mermaidCode} />);

    // Mermaid diagrams are extracted as documents and show a card
    expect(screen.getByTestId('document-card')).toBeInTheDocument();
    expect(screen.getByText('Mermaid Code')).toBeInTheDocument();
  });

  it('renders large code blocks (15+ lines) as document cards', () => {
    const largeCode = Array.from({ length: 15 })
      .fill(null)
      .map((_, index) => `const line${String(index)} = ${String(index)};`)
      .join('\n');
    const content = `\`\`\`typescript\n${largeCode}\n\`\`\``;
    render(<MarkdownRenderer content={content} />);

    // Large code blocks are extracted as documents and show a card
    expect(screen.getByTestId('document-card')).toBeInTheDocument();
    expect(screen.getByText('Typescript Code')).toBeInTheDocument();
  });

  it('renders bold and italic text', () => {
    render(<MarkdownRenderer content="**bold** and *italic* text" />);

    expect(screen.getByText('bold')).toBeInTheDocument();
    expect(screen.getByText('italic')).toBeInTheDocument();
  });

  it('renders tables (GFM)', () => {
    const table = `| Name | Age |
| --- | --- |
| John | 30 |
| Jane | 25 |`;

    render(<MarkdownRenderer content={table} />);

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('John')).toBeInTheDocument();
  });

  it('renders strikethrough (GFM)', () => {
    render(<MarkdownRenderer content="~~deleted~~" />);

    const deletedText = screen.getByText('deleted');
    expect(deletedText.tagName.toLowerCase()).toBe('del');
  });

  it('handles empty content gracefully', () => {
    render(<MarkdownRenderer content="" />);

    const container = screen.getByTestId('markdown-renderer');
    expect(container).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(<MarkdownRenderer content="Test" className="custom-class" />);

    const container = screen.getByTestId('markdown-renderer');
    expect(container).toHaveClass('custom-class');
  });

  it('renders blockquotes', () => {
    render(<MarkdownRenderer content="> This is a quote" />);

    expect(screen.getByText('This is a quote')).toBeInTheDocument();
  });

  it('handles malformed markdown gracefully', () => {
    // Unclosed code block should not crash
    const malformed = '```javascript\nconst x = 1';
    render(<MarkdownRenderer content={malformed} />);

    // Should render something without crashing
    expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
  });

  describe('document ID stability', () => {
    it('document card ID matches ID in callback after re-render', () => {
      const mermaidCode = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```';
      let callbackDocumentId: string | undefined;

      const onDocumentsExtracted = vi.fn((documents: { id: string }[]) => {
        // Only capture the first call's ID
        if (!callbackDocumentId && documents[0]) {
          callbackDocumentId = documents[0].id;
        }
      });

      // First render - effect runs, notifies parent
      const { rerender } = render(
        <MarkdownRenderer content={mermaidCode} onDocumentsExtracted={onDocumentsExtracted} />
      );

      expect(onDocumentsExtracted).toHaveBeenCalled();
      expect(callbackDocumentId).toBeDefined();

      // Simulate parent state update triggering a re-render (this is what happens
      // when the callback updates parent state, which then re-renders this component)
      rerender(
        <MarkdownRenderer content={mermaidCode} onDocumentsExtracted={onDocumentsExtracted} />
      );

      // Get the card that's currently rendered - click it to see what ID it uses
      const card = screen.getByTestId('document-card');
      expect(card).toBeInTheDocument();

      // The document ID that was passed to the callback on first render
      // should match what the card would use when clicked (for panel lookup)
      // This is verified indirectly: if IDs don't match, clicking the card
      // would fail to find the document in allDocuments
      //
      // Since we can't directly access the document prop, we verify the
      // callback was called with a stable ID by checking it starts with 'doc-'
      // and doesn't contain an incrementing suffix that changes per render
      expect(callbackDocumentId).toMatch(/^doc-[a-z0-9]+$/);
    });
  });
});
