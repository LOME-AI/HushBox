export interface Document {
  id: string;
  type: 'code' | 'mermaid' | 'html' | 'react';
  language?: string;
  title: string;
  content: string;
  lineCount: number;
}

export interface ParseResult {
  inlineContent: string;
  documents: Document[];
}

const MIN_LINES_FOR_DOCUMENT = 15;

/** Simple hash function for generating stable document IDs */
function hashContent(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index++) {
    const char = content.codePointAt(index) ?? 0;
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

function getDocumentType(language: string): Document['type'] {
  const lang = language.toLowerCase();
  if (lang === 'mermaid') return 'mermaid';
  if (lang === 'html') return 'html';
  if (lang === 'jsx' || lang === 'tsx') return 'react';
  return 'code';
}

const MERMAID_TITLES: Record<string, string> = {
  flowchart: 'Flowchart Diagram',
  sequenceDiagram: 'Sequence Diagram',
  classDiagram: 'Class Diagram',
  stateDiagram: 'State Diagram',
  erDiagram: 'ER Diagram',
  gantt: 'Gantt Chart',
  pie: 'Pie Chart',
  graph: 'Graph Diagram',
};

function getMermaidTitle(firstLine: string): string {
  for (const [prefix, title] of Object.entries(MERMAID_TITLES)) {
    if (firstLine.startsWith(prefix)) return title;
  }
  return 'Mermaid Diagram';
}

const CODE_PATTERNS: { regex: RegExp; group: number }[] = [
  {
    regex: /(?:function|const|let|var|export\s+(?:default\s+)?(?:function|const))\s+(\w+)/,
    group: 1,
  },
  { regex: /(?:class|interface|type|enum)\s+(\w+)/, group: 1 },
  { regex: /(?:def|class)\s+(\w+)/, group: 1 },
];

function isCommentLine(line: string): boolean {
  return (
    line.startsWith('//') ||
    line.startsWith('#') ||
    line.startsWith('/*') ||
    line.startsWith('*') ||
    line.startsWith('*/')
  );
}

function extractCodeTitle(lines: string[]): string | null {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || isCommentLine(trimmed)) continue;

    for (const { regex, group } of CODE_PATTERNS) {
      const match = regex.exec(trimmed);
      if (match?.[group]) return match[group];
    }
    break;
  }
  return null;
}

function extractTitle(content: string, language: string, type: Document['type']): string {
  const lines = content.split('\n');

  if (type === 'mermaid') {
    return getMermaidTitle(lines[0]?.trim() ?? '');
  }

  const codeTitle = extractCodeTitle(lines);
  if (codeTitle) return codeTitle;

  return `${language.charAt(0).toUpperCase() + language.slice(1)} Code`;
}

/** Check if a code block should become a document */
function shouldExtractAsDocument(language: string | undefined, lineCount: number): boolean {
  // No language = stays inline regardless of length
  if (!language) {
    return false;
  }

  // Mermaid always extracts (needs rendering)
  if (language.toLowerCase() === 'mermaid') {
    return true;
  }

  // Other code blocks need 15+ lines
  return lineCount >= MIN_LINES_FOR_DOCUMENT;
}

/** Extract documents from markdown content */
export function extractDocuments(content: string): ParseResult {
  const documents: Document[] = [];
  let inlineContent = content;

  // Regex to match fenced code blocks with optional language
  // Captures: 1=language (optional), 2=content
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;

  let match: RegExpExecArray | null;
  const replacements: { original: string; replacement: string }[] = [];

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // match[0] is always the full match, match[1] is language (may be empty), match[2] is content
    const fullMatch = match[0];
    const language = match[1] ?? '';
    const codeContent = match[2] ?? '';

    const trimmedContent = codeContent.replace(/\n$/, '');
    const lineCount = trimmedContent.split('\n').length;

    if (shouldExtractAsDocument(language || undefined, lineCount)) {
      const type = getDocumentType(language);
      const title = extractTitle(trimmedContent, language, type);
      const id = `doc-${hashContent(trimmedContent)}`;

      const document: Document = {
        id,
        type,
        title,
        content: trimmedContent,
        lineCount,
      };
      if (language) {
        document.language = language;
      }
      documents.push(document);

      replacements.push({
        original: fullMatch,
        replacement: `<!--doc:${id}-->`,
      });
    }
  }

  // Apply replacements in reverse order to preserve positions
  for (const { original, replacement } of replacements.toReversed()) {
    inlineContent = inlineContent.replace(original, replacement);
  }

  return { documents, inlineContent };
}
