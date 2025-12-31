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
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/** Determine document type from language */
function getDocumentType(language: string): Document['type'] {
  const lang = language.toLowerCase();
  if (lang === 'mermaid') {
    return 'mermaid';
  }
  if (lang === 'html') {
    return 'html';
  }
  if (lang === 'jsx' || lang === 'tsx') {
    return 'react';
  }
  return 'code';
}

/** Extract a meaningful title from code content */
function extractTitle(content: string, language: string, type: Document['type']): string {
  const lines = content.split('\n');

  // For mermaid, use diagram type
  if (type === 'mermaid') {
    const firstLine = lines[0]?.trim() ?? '';
    if (firstLine.startsWith('flowchart')) return 'Flowchart Diagram';
    if (firstLine.startsWith('sequenceDiagram')) return 'Sequence Diagram';
    if (firstLine.startsWith('classDiagram')) return 'Class Diagram';
    if (firstLine.startsWith('stateDiagram')) return 'State Diagram';
    if (firstLine.startsWith('erDiagram')) return 'ER Diagram';
    if (firstLine.startsWith('gantt')) return 'Gantt Chart';
    if (firstLine.startsWith('pie')) return 'Pie Chart';
    if (firstLine.startsWith('graph')) return 'Graph Diagram';
    return 'Mermaid Diagram';
  }

  // For code, try to find function/class/component name
  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments (including multiline comment lines)
    if (
      !trimmed ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('*/')
    ) {
      continue;
    }

    // Function patterns
    const functionMatch =
      /(?:function|const|let|var|export\s+(?:default\s+)?(?:function|const))\s+(\w+)/.exec(trimmed);
    if (functionMatch?.[1]) {
      return functionMatch[1];
    }

    // Class patterns
    const classMatch = /(?:class|interface|type|enum)\s+(\w+)/.exec(trimmed);
    if (classMatch?.[1]) {
      return classMatch[1];
    }

    // Python function/class
    const pythonMatch = /(?:def|class)\s+(\w+)/.exec(trimmed);
    if (pythonMatch?.[1]) {
      return pythonMatch[1];
    }

    // If we found a non-comment line but couldn't extract a name, stop looking
    break;
  }

  // Fallback to language name
  const langDisplay = language.charAt(0).toUpperCase() + language.slice(1);
  return `${langDisplay} Code`;
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

      const doc: Document = {
        id,
        type,
        title,
        content: trimmedContent,
        lineCount,
      };
      if (language) {
        doc.language = language;
      }
      documents.push(doc);

      replacements.push({
        original: fullMatch,
        replacement: `<!--doc:${id}-->`,
      });
    }
  }

  // Apply replacements in reverse order to preserve positions
  for (const { original, replacement } of replacements.reverse()) {
    inlineContent = inlineContent.replace(original, replacement);
  }

  return { documents, inlineContent };
}
