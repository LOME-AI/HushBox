import { bundledLanguagesInfo } from 'shiki';

export interface Document {
  id: string;
  type: 'code' | 'mermaid' | 'html' | 'react';
  language?: string;
  title: string;
  content: string;
  lineCount: number;
}

export const MIN_LINES_FOR_DOCUMENT = 15;

// Build display name lookup once: id → name, alias → name
const DISPLAY_NAMES = new Map<string, string>();
for (const lang of bundledLanguagesInfo) {
  DISPLAY_NAMES.set(lang.id, lang.name);
  if (lang.aliases) {
    for (const alias of lang.aliases) {
      DISPLAY_NAMES.set(alias, lang.name);
    }
  }
}

// Build extension lookup: language ID/alias → shortest alphanumeric alias
const FILE_EXTENSIONS = new Map<string, string>();
for (const lang of bundledLanguagesInfo) {
  const candidates = (lang.aliases ?? [])
    .filter((a) => /^[a-z\d]+$/i.test(a))
    .toSorted((a, b) => a.length - b.length);
  const extension = candidates[0];
  if (extension) {
    FILE_EXTENSIONS.set(lang.id, extension);
    for (const alias of lang.aliases ?? []) {
      FILE_EXTENSIONS.set(alias, extension);
    }
  }
}

/** Get proper display name for a language ID or alias */
export function getLanguageDisplayName(language: string): string {
  return (
    DISPLAY_NAMES.get(language.toLowerCase()) ??
    language.charAt(0).toUpperCase() + language.slice(1)
  );
}

/** Get file extension for a language ID, using Shiki alias data */
export function getFileExtension(language: string): string {
  return FILE_EXTENSIONS.get(language.toLowerCase()) ?? language.toLowerCase();
}

/** Get document type from language */
export function getDocumentType(language: string): Document['type'] {
  const lang = language.toLowerCase();
  if (lang === 'mermaid') return 'mermaid';
  if (lang === 'html') return 'html';
  if (lang === 'jsx' || lang === 'tsx') return 'react';
  return 'code';
}

/** Generate a stable ID for a document based on content hash */
export function generateDocumentId(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index++) {
    const char = content.codePointAt(index) ?? 0;
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `doc-${Math.abs(hash).toString(36)}`;
}

/** Check if a code block should be extracted as a document */
export function shouldExtractAsDocument(language: string | undefined, lineCount: number): boolean {
  if (!language) return false;
  if (language.toLowerCase() === 'mermaid') return true;
  return lineCount >= MIN_LINES_FOR_DOCUMENT;
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

export function extractTitle(content: string, language: string, type: Document['type']): string {
  const lines = content.split('\n');

  if (type === 'mermaid') {
    return getMermaidTitle(lines[0]?.trim() ?? '');
  }

  const codeTitle = extractCodeTitle(lines);
  if (codeTitle) return codeTitle;

  return getLanguageDisplayName(language);
}
