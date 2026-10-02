import * as React from 'react';
import { Streamdown } from 'streamdown';
import { mermaid } from '@streamdown/mermaid';
import { math } from '@streamdown/math';
import { cn, ErrorBoundary } from '@hushbox/ui';
import { CODE_TOKEN_KINDS, CODE_TOKEN_THEME } from '@hushbox/ui/code-highlight';
import { TEST_IDS } from '@hushbox/shared';
import { CodeBlockHeader } from '@/components/chat/message/code-block-header';
import { DiagramCard } from '@/components/chat/message/diagram-card';
import { safeCode } from '@/components/chat/message/code-plugin';
import { DocumentCard } from '@/components/chat/media/document-card';
import { ExternalLinkDialog } from '@/components/chat/segments/external-link-dialog';
import {
  extractTitle,
  generateDocumentId,
  getDocumentType,
  shouldExtractAsDocument,
} from '@/lib/chat/document-parser';
import type { Components, LinkSafetyConfig } from 'streamdown';
import type { Document } from '@/lib/chat/document-parser';

/**
 * Streamdown's link check, confirmed in the app's own dialog so an answer's
 * links and a search row's sources ask the same question. Defined once at
 * module scope: Streamdown re-renders every block when this object changes.
 */
const LINK_SAFETY: LinkSafetyConfig = {
  enabled: true,
  renderModal: ({ isOpen, url, onClose }) => (
    <ExternalLinkDialog url={isOpen ? url : null} onClose={onClose} />
  ),
};

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
  /** Whether the message is currently streaming */
  isStreaming?: boolean | undefined;
  /**
   * Whether a document-worthy fenced block becomes a document's card. Off for
   * text that is about the answer rather than the answer itself — a reasoning
   * trace, where a long fence is the model thinking aloud and minting a
   * runnable document from it would put a card inside the trace.
   */
  extractDocuments?: boolean | undefined;
}

/** Extract text content from a HAST (HTML AST) node tree */
function extractTextFromHast(node: HastNode): string {
  if (node.type === 'text') {
    return node.value;
  }
  /* v8 ignore start -- Streamdown's safe pipeline only emits text/element nodes; the childless-non-text fallback guards a node shape that never reaches here */
  if ('children' in node) {
    return node.children.map((child) => extractTextFromHast(child)).join('');
  }
  return '';
  /* v8 ignore stop */
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
  /* v8 ignore next -- a Streamdown <pre> always wraps a <code> element, so the non-code first-child guard is unreachable */
  if (codeNode?.type !== 'element' || codeNode.tagName !== 'code') return undefined;
  const language = extractLanguageFromCodeNode(codeNode);
  if (!language) return undefined;
  const codeText = extractTextFromHast(codeNode).replace(/\n$/, '');
  const lineCount = codeText.split('\n').length;
  return { language, codeText, lineCount };
}

// Carried by context rather than closed over: `components` stays referentially
// stable (Streamdown re-renders every block when it changes), while context
// updates still reach each block through those memo boundaries.
const MessageStreamingContext = React.createContext(false);

/** Carried the same way and for the same reason as {@link MessageStreamingContext}. */
const DocumentExtractionContext = React.createContext(true);

interface CodeElementProps {
  className?: string;
  children?: React.ReactNode;
  'data-block'?: string;
}

/** The language Streamdown reads from a fence's class, spelled as the fence spells it. */
const FENCE_LANGUAGE = /language-(\S+)/;

// Streamdown draws its own header and a floating toolbar inside the block it renders.
// With `controls.code` off its toolbar never renders, and these descendant rules hide its
// header and flatten its frame into this one, as the renderer's link recolour does.
const CODE_BLOCK_CLASS = cn(
  'not-prose bg-muted border-border my-4 overflow-hidden rounded-lg border font-sans',
  '[&_[data-streamdown=code-block]]:m-0 [&_[data-streamdown=code-block]]:gap-0 [&_[data-streamdown=code-block]]:rounded-none [&_[data-streamdown=code-block]]:border-0 [&_[data-streamdown=code-block]]:bg-transparent [&_[data-streamdown=code-block]]:p-0',
  '[&_[data-streamdown=code-block-header]]:hidden',
  '[&_[data-streamdown=code-block-body]]:rounded-none [&_[data-streamdown=code-block-body]]:border-0 [&_[data-streamdown=code-block-body]]:bg-transparent [&_[data-streamdown=code-block-body]]:px-4 [&_[data-streamdown=code-block-body]]:py-3.5 [&_[data-streamdown=code-block-body]]:text-[0.8125rem] [&_[data-streamdown=code-block-body]]:leading-relaxed md:[&_[data-streamdown=code-block-body]]:text-sm',
  '[&_[data-streamdown=code-block-body]_pre]:bg-transparent',
  '[&_[data-streamdown=code-block-body]_code>span]:before:text-muted-foreground [&_[data-streamdown=code-block-body]_code>span]:before:text-[length:inherit]'
);

// The shared theme hands each token back as a `--code-token-<kind>` variable with no
// colour of its own. The frame binds each to the palette's source variable, which
// already changes with the app's theme, not to Tailwind's `--color-code-*` alias, which
// Tailwind emits only when a utility in the app's sources uses it. The muted fill holds
// only while every kind clears 4.5:1 against it in both themes.
const CODE_TOKEN_COLOURS: React.CSSProperties & Record<`--code-${string}`, string> = {
  '--code-foreground': 'var(--foreground)',
  '--code-background': 'transparent',
  ...Object.fromEntries(
    CODE_TOKEN_KINDS.map((kind) => [`--code-token-${kind}`, `var(--code-${kind})`])
  ),
};

// Streamdown highlights with the pair the code plugin's `getThemes` returns, so this keeps
// the language guard `safeCode` adds and swaps only the themes.
const CODE_PLUGIN: typeof safeCode = {
  ...safeCode,
  getThemes: () => [CODE_TOKEN_THEME, CODE_TOKEN_THEME],
};

/** A document in the thread: a diagram draws in place, and every other kind opens in the panel. */
function ThreadDocument({ document }: Readonly<{ document: Document }>): React.JSX.Element {
  return document.type === 'mermaid' ? (
    <DiagramCard document={document} />
  ) : (
    <DocumentCard document={document} />
  );
}

/**
 * Intercepts document-worthy code blocks before Streamdown's own code block
 * renders. Streamdown's default `pre` adds `data-block="true"` to its children,
 * which MarkdownCode uses to tell block from inline code.
 */
function MarkdownPre({
  children,
  node,
}: Readonly<{ children?: React.ReactNode; node?: HastElement | undefined }>): React.JSX.Element {
  const isStreaming = React.useContext(MessageStreamingContext);
  const extractDocuments = React.useContext(DocumentExtractionContext);
  const meta = extractCodeBlockMeta(node);

  if (extractDocuments && meta && shouldExtractAsDocument(meta.language, meta.lineCount)) {
    const type = getDocumentType(meta.language);
    const document_: Document = {
      id: generateDocumentId(meta.codeText),
      type,
      language: meta.language,
      title: extractTitle(meta.codeText, meta.language, type),
      content: meta.codeText,
      lineCount: meta.lineCount,
      isStreaming,
    };

    return <ThreadDocument document={document_} />;
  }

  /* v8 ignore next -- Streamdown always passes the <code> element as pre children, so the non-element fallback branch is unreachable */
  if (!React.isValidElement<CodeElementProps>(children)) return <>{children}</>;

  const block = React.cloneElement(children, { 'data-block': 'true' });
  const language = FENCE_LANGUAGE.exec(children.props.className ?? '')?.[1] ?? '';
  if (language === 'mermaid') return block;

  return (
    <div className={CODE_BLOCK_CLASS} style={CODE_TOKEN_COLOURS}>
      <CodeBlockHeader
        language={language}
        code={typeof children.props.children === 'string' ? children.props.children : ''}
      />
      {block}
    </div>
  );
}

function MarkdownRenderFallback({ content }: Readonly<{ content: string }>): React.JSX.Element {
  return (
    <div data-testid={TEST_IDS.markdownRenderFallback}>
      <p className="text-base leading-relaxed break-words whitespace-pre-wrap">{content}</p>
      <p className="text-muted-foreground mt-2 text-xs">Message formatting unavailable.</p>
    </div>
  );
}

export function MarkdownRenderer({
  content,
  className,
  isStreaming,
  extractDocuments,
}: Readonly<MarkdownRendererProps>): React.JSX.Element {
  const components = React.useMemo<Partial<Components>>(
    () => ({
      // Intercepts BEFORE MarkdownCode fires for large blocks and mermaid.
      pre: MarkdownPre as NonNullable<Components['pre']>,
    }),
    // Deliberately empty: a new `components` object re-renders every Streamdown
    // block. Per-message data reaches the overrides through context instead.
    []
  );

  return (
    <div
      data-testid={TEST_IDS.markdownRenderer}
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none wrap-anywhere',
        'prose-headings:mb-2 prose-headings:mt-4',
        'prose-p:my-2',
        'prose-ul:my-2 prose-ol:my-2',
        'prose-li:my-0.5',
        'prose-blockquote:my-2',
        'prose-pre:p-0',
        // Recolours Streamdown's own link element instead of replacing it: an
        // override would have to re-supply the link-safety interstitial and
        // `rel="noreferrer" target="_blank"` that the default carries. The
        // element is a button, not an anchor, whenever link safety is on, so
        // this selects the library's marker rather than a tag.
        '[&_[data-streamdown=link]]:text-brand-red',
        className
      )}
    >
      <ErrorBoundary
        fallback={() => <MarkdownRenderFallback content={content} />}
        resetKey={content}
      >
        <MessageStreamingContext.Provider value={isStreaming ?? false}>
          <DocumentExtractionContext.Provider value={extractDocuments ?? true}>
            <Streamdown
              plugins={{ code: CODE_PLUGIN, mermaid, math }}
              components={components}
              controls={{ code: false, mermaid: { copy: true, download: true } }}
              linkSafety={LINK_SAFETY}
              isAnimating={isStreaming ?? false}
              animated
            >
              {content}
            </Streamdown>
          </DocumentExtractionContext.Provider>
        </MessageStreamingContext.Provider>
      </ErrorBoundary>
    </div>
  );
}
