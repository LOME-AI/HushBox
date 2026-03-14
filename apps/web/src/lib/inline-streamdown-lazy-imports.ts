/**
 * Transforms Streamdown's lazy-loaded dynamic imports into static imports.
 *
 * Streamdown uses React.lazy(() => import('./code-block-X.js')) which creates
 * separate chunks that can fail to load after deployment (old chunks removed
 * from CDN). This transform inlines them into the main bundle, eliminating
 * the failure mode entirely.
 *
 * Returns the transformed source, or null if no transformation was needed.
 */
export function transformStreamdownSource(code: string): string | null {
  if (!code.includes('code-block-') && !code.includes('mermaid-')) return null;

  let result = code;
  let changed = false;

  const codeBlockImportMatch = /import\('(\.\/code-block-[^']+)'\)/.exec(result);
  if (codeBlockImportMatch) {
    const importPath = codeBlockImportMatch[1] ?? '';
    result = `import {CodeBlock as __SD_CodeBlock} from '${importPath}';\n` + result;
    result = result.replace(
      /lazy\(\(\)=>import\('[^']*code-block-[^']*'\)\.then\(\w+=>\(\{default:\w+\.CodeBlock\}\)\)\)/,
      '__SD_CodeBlock'
    );
    changed = true;
  }

  const mermaidImportMatch = /import\('(\.\/mermaid-[^']+)'\)/.exec(result);
  if (mermaidImportMatch) {
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
