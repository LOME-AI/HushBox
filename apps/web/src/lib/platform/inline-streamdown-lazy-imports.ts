/**
 * Transforms Streamdown's two React.lazy dynamic imports, the code-block body
 * (./highlighted-body-X.js) and the Mermaid diagram (./mermaid-X.js), into static
 * imports, so both components load with the chunk that holds streamdown.
 *
 * Returns the transformed source, or null if no transformation was needed.
 */
export function transformStreamdownSource(code: string): string | null {
  if (!code.includes('highlighted-body-') && !code.includes('mermaid-')) return null;

  let result = code;
  let changed = false;

  const codeBlockImportMatch = /import\('(\.\/highlighted-body-[^']+)'\)/.exec(result);
  if (codeBlockImportMatch) {
    /* v8 ignore next -- the regex has a mandatory capture group, so a match always populates [1]; the `?? ''` fallback is unreachable. */
    const importPath = codeBlockImportMatch[1] ?? '';
    result = `import {HighlightedCodeBlockBody as __SD_CodeBlock} from '${importPath}';\n` + result;
    result = result.replace(
      /lazy\(\(\)=>import\('[^']*highlighted-body-[^']*'\)\.then\(\w+=>\(\{default:\w+\.HighlightedCodeBlockBody\}\)\)\)/,
      '__SD_CodeBlock'
    );
    changed = true;
  }

  const mermaidImportMatch = /import\('(\.\/mermaid-[^']+)'\)/.exec(result);
  if (mermaidImportMatch) {
    /* v8 ignore next -- the regex has a mandatory capture group, so a match always populates [1]; the `?? ''` fallback is unreachable. */
    const importPath = mermaidImportMatch[1] ?? '';
    result = `import {Mermaid as __SD_Mermaid} from '${importPath}';\n` + result;
    result = result.replace(
      /lazy\(\(\)=>import\('[^']*mermaid-[^']*'\)\.then\(\w+=>\(\{default:\w+\.Mermaid\}\)\)\)/,
      '__SD_Mermaid'
    );
    changed = true;
  }

  return changed ? result : null;
}
