import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { cn } from '@lome-chat/ui';
import { CodeBlock } from './code-block';
import { MermaidDiagram } from './mermaid-diagram';
import { DocumentCard } from './document-card';
import type { Document } from '../../lib/document-parser';
import type { Components } from 'react-markdown';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /** Unique ID for this message (used for document registration) */
  messageId?: string;
  /** Callback when documents are extracted */
  onDocumentsExtracted?: (documents: Document[]) => void;
}

/** Extract text content from React node tree (handles syntax-highlighted code) */
function extractTextFromChildren(children: React.ReactNode): string {
  if (typeof children === 'string') {
    return children;
  }
  if (typeof children === 'number') {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map((child: React.ReactNode) => extractTextFromChildren(child)).join('');
  }
  if (React.isValidElement(children)) {
    const props = children.props as { children?: React.ReactNode };
    return extractTextFromChildren(props.children);
  }
  return '';
}

const MIN_LINES_FOR_DOCUMENT = 15;

/** Check if a code block should be rendered as a document card */
function shouldRenderAsDocument(language: string | undefined, lineCount: number): boolean {
  if (!language) return false;
  if (language === 'mermaid') return true;
  return lineCount >= MIN_LINES_FOR_DOCUMENT;
}

/** Generate a stable ID for a document based on content */
function generateDocumentId(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index++) {
    const char = content.codePointAt(index) ?? 0;
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `doc-${Math.abs(hash).toString(36)}`;
}

/** Get document type from language */
function getDocumentType(language: string): Document['type'] {
  const lang = language.toLowerCase();
  if (lang === 'mermaid') return 'mermaid';
  if (lang === 'html') return 'html';
  if (lang === 'jsx' || lang === 'tsx') return 'react';
  return 'code';
}

export function MarkdownRenderer({
  content,
  className,
  onDocumentsExtracted,
}: Readonly<MarkdownRendererProps>): React.JSX.Element {
  // Track documents found during this render pass
  const currentDocumentsRef = React.useRef<Document[]>([]);
  const previousContentRef = React.useRef<string>('');

  // Reset document tracking on each render if content changed
  if (previousContentRef.current !== content) {
    currentDocumentsRef.current = [];
    previousContentRef.current = content;
  }

  // Preserve consecutive empty lines by inserting non-breaking space
  const processedContent = content.replaceAll('\n\n', '\n\n&nbsp;\n\n');

  const components: Partial<Components> = React.useMemo(
    () => ({
      // Custom code block handler
      code: ({ className: codeClassName, children, ...props }) => {
        const match = /language-(\w+)/.exec(codeClassName ?? '');
        const language = match?.[1];
        const codeContent = extractTextFromChildren(children).replace(/\n$/, '');
        const lineCount = codeContent.split('\n').length;

        // Check if this is an inline code block (no language class and short content)
        const isInline = !codeClassName && !codeContent.includes('\n');

        if (isInline) {
          return (
            <code className="bg-muted rounded px-1.5 py-0.5 text-sm" {...props}>
              {children}
            </code>
          );
        }

        // Check if this should be a document
        if (language && shouldRenderAsDocument(language, lineCount)) {
          const document_: Document = {
            id: generateDocumentId(codeContent),
            type: getDocumentType(language),
            language,
            title: language.charAt(0).toUpperCase() + language.slice(1) + ' Code',
            content: codeContent,
            lineCount,
          };

          currentDocumentsRef.current.push(document_);

          return <DocumentCard document={document_} />;
        }

        // Handle mermaid diagrams inline (this shouldn't happen since mermaid always becomes a doc)
        if (language === 'mermaid') {
          return <MermaidDiagram chart={codeContent} />;
        }

        // Regular code block - wrap in overflow container to prevent pushing chat offscreen
        return (
          <div className="max-w-full overflow-x-auto">
            <CodeBlock language={language}>{codeContent}</CodeBlock>
          </div>
        );
      },
      // Custom pre handler to avoid double-wrapping
      pre: ({ children }) => <>{children}</>,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content]
  );

  // Notify parent of extracted documents after render
  React.useEffect(() => {
    if (onDocumentsExtracted && currentDocumentsRef.current.length > 0) {
      onDocumentsExtracted([...currentDocumentsRef.current]);
    }
  }, [content, onDocumentsExtracted]);

  return (
    <div
      data-testid="markdown-renderer"
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none wrap-anywhere',
        // Customize prose styles
        'prose-headings:mb-2 prose-headings:mt-4',
        'prose-p:my-2',
        'prose-ul:my-2 prose-ol:my-2',
        'prose-li:my-0.5',
        'prose-blockquote:my-2',
        'prose-pre:p-0 prose-pre:bg-transparent',
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={components}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
}
