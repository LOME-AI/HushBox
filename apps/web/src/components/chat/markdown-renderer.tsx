import * as React from 'react';
import { Streamdown } from 'streamdown';
import type { Components } from 'streamdown';
import { code } from '@streamdown/code';
import { mermaid } from '@streamdown/mermaid';
import { math } from '@streamdown/math';
import { cn } from '@hushbox/ui';
import { ErrorBoundary } from '../shared/error-boundary';
import { DocumentCard } from './document-card';
import {
  extractTitle,
  generateDocumentId,
  getDocumentType,
  shouldExtractAsDocument,
} from '../../lib/document-parser';
import type { Document } from '../../lib/document-parser';

/** Minimal HAST node types (avoids @types/hast dependency) */
interface HastText {
  type: 'text';
  value: string;
}

interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}

type HastNode = HastText | HastElement;

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /** Whether this message is an error — applies inline color:inherit to links */
  isError?: boolean | undefined;
  /** Whether the message is currently streaming */
  isStreaming?: boolean | undefined;
}

/** Extract text content from a HAST (HTML AST) node tree */
function extractTextFromHast(node: HastNode): string {
  if (node.type === 'text') {
    return node.value;
  }
  if ('children' in node) {
    return node.children.map((child) => extractTextFromHast(child)).join('');
  }
  return '';
}

interface CodeBlockMeta {
  language: string;
  codeText: string;
  lineCount: number;
}

function extractLanguageFromCodeNode(codeNode: HastElement): string | undefined {
  const classNames = codeNode.properties?.['className'];
  const rawClass: unknown = Array.isArray(classNames) ? classNames[0] : classNames;
  if (typeof rawClass !== 'string') return undefined;
  return /language-([\w-]+)/.exec(rawClass)?.[1];
}

function extractCodeBlockMeta(node: HastElement | undefined): CodeBlockMeta | undefined {
  const codeNode = node?.children[0];
  if (codeNode?.type !== 'element' || codeNode.tagName !== 'code') return undefined;
  const language = extractLanguageFromCodeNode(codeNode);
  if (!language) return undefined;
  const codeText = extractTextFromHast(codeNode).replace(/\n$/, '');
  const lineCount = codeText.split('\n').length;
  return { language, codeText, lineCount };
}

function MarkdownRenderFallback({ content }: Readonly<{ content: string }>): React.JSX.Element {
  return (
    <div data-testid="markdown-render-fallback">
      <p className="text-base leading-relaxed break-words whitespace-pre-wrap">{content}</p>
      <p className="text-muted-foreground mt-2 text-xs">Message formatting unavailable.</p>
    </div>
  );
}

export function MarkdownRenderer({
  content,
  className,
  isError,
  isStreaming,
}: Readonly<MarkdownRendererProps>): React.JSX.Element {
  const components = React.useMemo<Partial<Components>>(
    () => ({
      // Override pre to intercept document-worthy code blocks.
      // Streamdown's default pre adds data-block="true" to children, which
      // MarkdownCode uses to distinguish block vs inline code.
      // We intercept BEFORE MarkdownCode fires for large blocks and mermaid.
      pre: ((props: { children?: React.ReactNode; node?: HastElement | undefined }) => {
        const { children, node } = props;
        const meta = extractCodeBlockMeta(node);

        if (meta && shouldExtractAsDocument(meta.language, meta.lineCount)) {
          const type = getDocumentType(meta.language);
          const document_: Document = {
            id: generateDocumentId(meta.codeText),
            type,
            language: meta.language,
            title: extractTitle(meta.codeText, meta.language, type),
            content: meta.codeText,
            lineCount: meta.lineCount,
          };

          return <DocumentCard document={document_} />;
        }

        // Default behavior: add data-block for MarkdownCode to detect block vs inline
        return React.isValidElement(children) ? (
          React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            'data-block': 'true',
          })
        ) : (
          <>{children}</>
        );
      }) as NonNullable<Components['pre']>,
      // Error messages: style links red (brand-red) to stand out.
      // Always define `a` to avoid exactOptionalPropertyTypes issues with conditional spread.
      a: (({
        children,
        href,
        ...props
      }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
        children?: React.ReactNode;
      }) => (
        <a href={href} {...(isError ? { style: { color: 'var(--brand-red)' } } : {})} {...props}>
          {children}
        </a>
      )) as NonNullable<Components['a']>,
    }),
    // `content` excluded: ref reads happen at execution time, not closure time.
    // Streamdown re-renders on children change independently.

    [isError]
  );

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
        'prose-pre:p-0',
        className
      )}
    >
      <ErrorBoundary fallback={<MarkdownRenderFallback content={content} />}>
        <Streamdown
          plugins={{ code, mermaid, math }}
          components={components}
          controls={{ code: true, mermaid: { copy: true, download: true } }}
          isAnimating={isStreaming ?? false}
          animated
        >
          {content}
        </Streamdown>
      </ErrorBoundary>
    </div>
  );
}
