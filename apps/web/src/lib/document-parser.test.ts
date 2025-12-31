import { describe, it, expect } from 'vitest';
import { extractDocuments } from './document-parser';

describe('extractDocuments', () => {
  describe('returns empty documents for content without code blocks', () => {
    it('handles plain text', () => {
      const content = 'This is just some plain text.';
      const result = extractDocuments(content);

      expect(result.documents).toEqual([]);
      expect(result.inlineContent).toBe(content);
    });

    it('handles markdown with headers and lists', () => {
      const content = `# Title

- Item 1
- Item 2

Some paragraph text.`;
      const result = extractDocuments(content);

      expect(result.documents).toEqual([]);
      expect(result.inlineContent).toBe(content);
    });

    it('handles inline code', () => {
      const content = 'Use the `useState` hook for state management.';
      const result = extractDocuments(content);

      expect(result.documents).toEqual([]);
      expect(result.inlineContent).toBe(content);
    });
  });

  describe('keeps short code blocks inline', () => {
    it('keeps code blocks under 15 lines inline', () => {
      const content = `Here's an example:

\`\`\`typescript
function hello() {
  return 'world';
}
\`\`\`

That's it!`;
      const result = extractDocuments(content);

      expect(result.documents).toEqual([]);
      expect(result.inlineContent).toBe(content);
    });

    it('keeps code blocks without language inline regardless of length', () => {
      const longCode = Array(20).fill('line').join('\n');
      const content = `\`\`\`
${longCode}
\`\`\``;
      const result = extractDocuments(content);

      expect(result.documents).toEqual([]);
      expect(result.inlineContent).toBe(content);
    });
  });

  describe('extracts code blocks with language ≥15 lines', () => {
    it('extracts a 15-line TypeScript code block', () => {
      const codeContent = Array(15)
        .fill(null)
        .map((_, i) => `const line${String(i)} = ${String(i)};`)
        .join('\n');
      const content = `Here's the code:

\`\`\`typescript
${codeContent}
\`\`\`

Done!`;
      const result = extractDocuments(content);

      expect(result.documents).toHaveLength(1);
      const doc = result.documents[0];
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.type).toBe('code');
        expect(doc.language).toBe('typescript');
        expect(doc.content).toBe(codeContent);
        expect(doc.lineCount).toBe(15);
      }
    });

    it('extracts a 20-line Python code block', () => {
      const codeContent = Array(20)
        .fill(null)
        .map((_, i) => `x${String(i)} = ${String(i)}`)
        .join('\n');
      const content = `\`\`\`python
${codeContent}
\`\`\``;
      const result = extractDocuments(content);

      expect(result.documents).toHaveLength(1);
      const doc = result.documents[0];
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.type).toBe('code');
        expect(doc.language).toBe('python');
        expect(doc.lineCount).toBe(20);
      }
    });

    it('replaces extracted code with placeholder in inline content', () => {
      const codeContent = Array(15)
        .fill(null)
        .map((_, i) => `line ${String(i)}`)
        .join('\n');
      const content = `Before

\`\`\`javascript
${codeContent}
\`\`\`

After`;
      const result = extractDocuments(content);

      expect(result.documents).toHaveLength(1);
      const doc = result.documents[0];
      expect(doc).toBeDefined();
      if (doc) {
        expect(result.inlineContent).toContain(`<!--doc:${doc.id}-->`);
        expect(result.inlineContent).not.toContain(codeContent);
      }
    });
  });

  describe('extracts mermaid diagrams regardless of size', () => {
    it('extracts a small mermaid diagram', () => {
      const content = `\`\`\`mermaid
flowchart TD
    A --> B
\`\`\``;
      const result = extractDocuments(content);

      expect(result.documents).toHaveLength(1);
      const doc = result.documents[0];
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.type).toBe('mermaid');
        expect(doc.content).toBe('flowchart TD\n    A --> B');
      }
    });

    it('extracts a large mermaid diagram', () => {
      const diagram = `flowchart TD
${Array(20)
  .fill(null)
  .map((_, i) => `    N${String(i)} --> N${String(i + 1)}`)
  .join('\n')}`;
      const content = `\`\`\`mermaid
${diagram}
\`\`\``;
      const result = extractDocuments(content);

      expect(result.documents).toHaveLength(1);
      const doc = result.documents[0];
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.type).toBe('mermaid');
      }
    });
  });

  describe('extracts HTML/JSX/TSX blocks ≥15 lines', () => {
    it('extracts a 15-line HTML block', () => {
      const htmlContent = Array(15)
        .fill(null)
        .map((_, i) => `<div>Line ${String(i)}</div>`)
        .join('\n');
      const content = `\`\`\`html
${htmlContent}
\`\`\``;
      const result = extractDocuments(content);

      expect(result.documents).toHaveLength(1);
      const doc = result.documents[0];
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.type).toBe('html');
        expect(doc.language).toBe('html');
      }
    });

    it('extracts a 15-line JSX block as react type', () => {
      const jsxContent = Array(15)
        .fill(null)
        .map((_, i) => `  <div key={${String(i)}}>{${String(i)}}</div>`)
        .join('\n');
      const content = `\`\`\`jsx
function Component() {
  return (
${jsxContent}
  );
}
\`\`\``;
      const result = extractDocuments(content);

      expect(result.documents).toHaveLength(1);
      const doc = result.documents[0];
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.type).toBe('react');
        expect(doc.language).toBe('jsx');
      }
    });

    it('extracts a 15-line TSX block as react type', () => {
      const tsxContent = Array(15)
        .fill(null)
        .map((_, i) => `  <span>{${String(i)}}</span>`)
        .join('\n');
      const content = `\`\`\`tsx
export function Component(): JSX.Element {
  return (
${tsxContent}
  );
}
\`\`\``;
      const result = extractDocuments(content);

      expect(result.documents).toHaveLength(1);
      const doc = result.documents[0];
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.type).toBe('react');
        expect(doc.language).toBe('tsx');
      }
    });

    it('keeps short HTML blocks inline', () => {
      const content = `\`\`\`html
<div>
  <p>Hello</p>
</div>
\`\`\``;
      const result = extractDocuments(content);

      expect(result.documents).toEqual([]);
      expect(result.inlineContent).toBe(content);
    });
  });

  describe('handles multiple documents in one message', () => {
    it('extracts multiple code blocks', () => {
      const code1 = Array(15)
        .fill(null)
        .map((_, i) => `// Line ${String(i)}`)
        .join('\n');
      const code2 = Array(15)
        .fill(null)
        .map((_, i) => `# Line ${String(i)}`)
        .join('\n');
      const content = `First file:

\`\`\`typescript
${code1}
\`\`\`

Second file:

\`\`\`python
${code2}
\`\`\``;
      const result = extractDocuments(content);

      expect(result.documents).toHaveLength(2);
      expect(result.documents[0]?.language).toBe('typescript');
      expect(result.documents[1]?.language).toBe('python');
    });

    it('extracts mixed document types', () => {
      const code = Array(15)
        .fill(null)
        .map((_, i) => `x = ${String(i)}`)
        .join('\n');
      const content = `Code:

\`\`\`python
${code}
\`\`\`

Diagram:

\`\`\`mermaid
flowchart TD
    A --> B
\`\`\``;
      const result = extractDocuments(content);

      expect(result.documents).toHaveLength(2);
      expect(result.documents[0]?.type).toBe('code');
      expect(result.documents[1]?.type).toBe('mermaid');
    });
  });

  describe('document ID generation', () => {
    it('generates stable IDs based on content hash', () => {
      const code = Array(15)
        .fill(null)
        .map((_, i) => `line ${String(i)}`)
        .join('\n');
      const content = `\`\`\`javascript
${code}
\`\`\``;

      const result1 = extractDocuments(content);
      const result2 = extractDocuments(content);

      expect(result1.documents[0]?.id).toBe(result2.documents[0]?.id);
    });

    it('generates different IDs for different content', () => {
      const code1 = Array(15)
        .fill(null)
        .map((_, i) => `a${String(i)}`)
        .join('\n');
      const code2 = Array(15)
        .fill(null)
        .map((_, i) => `b${String(i)}`)
        .join('\n');

      const result1 = extractDocuments(`\`\`\`javascript\n${code1}\n\`\`\``);
      const result2 = extractDocuments(`\`\`\`javascript\n${code2}\n\`\`\``);

      expect(result1.documents[0]?.id).not.toBe(result2.documents[0]?.id);
    });

    it('identical content blocks share the same ID (content-based hashing)', () => {
      const code = Array(15)
        .fill(null)
        .map((_, i) => `x = ${String(i)}`)
        .join('\n');
      const content = `\`\`\`python
${code}
\`\`\`

\`\`\`python
${code}
\`\`\``;
      const result = extractDocuments(content);

      expect(result.documents).toHaveLength(2);
      // Identical content produces identical IDs (content-based hashing)
      expect(result.documents[0]?.id).toBe(result.documents[1]?.id);
    });
  });

  describe('title generation', () => {
    it('generates title from first meaningful line of code', () => {
      const code = `function calculateTotal(items) {
${Array(14)
  .fill(null)
  .map(() => '  // implementation')
  .join('\n')}
}`;
      const content = `\`\`\`javascript
${code}
\`\`\``;
      const result = extractDocuments(content);

      const doc = result.documents[0];
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.title).toContain('calculateTotal');
      }
    });

    it('generates title for mermaid from diagram type', () => {
      const content = `\`\`\`mermaid
sequenceDiagram
    Alice->>Bob: Hello
\`\`\``;
      const result = extractDocuments(content);

      const doc = result.documents[0];
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.title.toLowerCase()).toContain('sequence');
      }
    });

    it('generates title for class diagram', () => {
      const content = `\`\`\`mermaid
classDiagram
    Animal <|-- Duck
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('Class Diagram');
    });

    it('generates title for state diagram', () => {
      const content = `\`\`\`mermaid
stateDiagram
    [*] --> Still
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('State Diagram');
    });

    it('generates title for ER diagram', () => {
      const content = `\`\`\`mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('ER Diagram');
    });

    it('generates title for gantt chart', () => {
      const content = `\`\`\`mermaid
gantt
    title A Gantt Diagram
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('Gantt Chart');
    });

    it('generates title for pie chart', () => {
      const content = `\`\`\`mermaid
pie
    "Dogs" : 386
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('Pie Chart');
    });

    it('generates title for graph diagram', () => {
      const content = `\`\`\`mermaid
graph TD
    A --> B
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('Graph Diagram');
    });

    it('generates fallback title for unknown mermaid type', () => {
      const content = `\`\`\`mermaid
unknownDiagram
    something
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('Mermaid Diagram');
    });

    it('falls back to language name when no meaningful title found', () => {
      const code = Array(15)
        .fill(null)
        .map((_, i) => `// comment ${String(i)}`)
        .join('\n');
      const content = `\`\`\`typescript
${code}
\`\`\``;
      const result = extractDocuments(content);

      const doc = result.documents[0];
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.title.toLowerCase()).toContain('typescript');
      }
    });

    it('extracts title from class definition', () => {
      const code = `class UserService {
${Array(14)
  .fill(null)
  .map(() => '  // implementation')
  .join('\n')}
}`;
      const content = `\`\`\`typescript
${code}
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('UserService');
    });

    it('extracts title from interface definition', () => {
      const code = `interface ApiResponse {
${Array(14)
  .fill(null)
  .map(() => '  field: string;')
  .join('\n')}
}`;
      const content = `\`\`\`typescript
${code}
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('ApiResponse');
    });

    it('extracts title from type definition', () => {
      const code = `type ConfigOptions = {
${Array(14)
  .fill(null)
  .map(() => '  option: boolean;')
  .join('\n')}
};`;
      const content = `\`\`\`typescript
${code}
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('ConfigOptions');
    });

    it('extracts title from enum definition', () => {
      const code = `enum Status {
${Array(14)
  .fill(null)
  .map((_, i) => `  Value${String(i)},`)
  .join('\n')}
}`;
      const content = `\`\`\`typescript
${code}
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('Status');
    });

    it('extracts title from Python def', () => {
      const code = `def process_data(items):
${Array(14)
  .fill(null)
  .map(() => '    pass')
  .join('\n')}`;
      const content = `\`\`\`python
${code}
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('process_data');
    });

    it('extracts title from Python class', () => {
      const code = `class DataProcessor:
${Array(14)
  .fill(null)
  .map(() => '    pass')
  .join('\n')}`;
      const content = `\`\`\`python
${code}
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('DataProcessor');
    });

    it('skips Python comments when finding title', () => {
      const code = `# This is a comment
def helper_function():
${Array(13)
  .fill(null)
  .map(() => '    pass')
  .join('\n')}`;
      const content = `\`\`\`python
${code}
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('helper_function');
    });

    it('skips multiline comments when finding title', () => {
      const code = `/* This is a
 * multiline comment
 */
function realFunction() {
${Array(11)
  .fill(null)
  .map(() => '  // impl')
  .join('\n')}
}`;
      const content = `\`\`\`javascript
${code}
\`\`\``;
      const result = extractDocuments(content);
      expect(result.documents[0]?.title).toBe('realFunction');
    });
  });
});
