import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { transformStreamdownSource } from './inline-streamdown-lazy-imports';

// Real patterns extracted from streamdown@2.2.0 dist/chunk-LPQFK2AO.js
const LAZY_CODE_BLOCK = `lazy(()=>import('./code-block-OCS4YCEC.js').then(e=>({default:e.CodeBlock})))`;
const LAZY_MERMAID = `lazy(()=>import('./mermaid-NOHMQCX5.js').then(e=>({default:e.Mermaid})))`;

describe('transformStreamdownSource', () => {
  it('returns null for code without lazy imports', () => {
    const code = 'var x = 1; export default x;';
    expect(transformStreamdownSource(code)).toBeNull();
  });

  it('returns null for code mentioning code-block but without lazy pattern', () => {
    const code = '// This file handles code-block rendering';
    expect(transformStreamdownSource(code)).toBeNull();
  });

  it('replaces code-block lazy import with static import', () => {
    const code = `var mn=${LAZY_CODE_BLOCK};`;
    const result = transformStreamdownSource(code);

    expect(result).not.toBeNull();
    expect(result).toContain(
      `import {CodeBlock as __SD_CodeBlock} from './code-block-OCS4YCEC.js';`
    );
    expect(result).toContain('var mn=__SD_CodeBlock;');
    expect(result).not.toContain('lazy(');
  });

  it('replaces mermaid lazy import with static import', () => {
    const code = `var pn=${LAZY_MERMAID};`;
    const result = transformStreamdownSource(code);

    expect(result).not.toBeNull();
    expect(result).toContain(`import {Mermaid as __SD_Mermaid} from './mermaid-NOHMQCX5.js';`);
    expect(result).toContain('var pn=__SD_Mermaid;');
    expect(result).not.toContain('lazy(');
  });

  it('replaces both lazy imports in a single file', () => {
    const code = `var mn=${LAZY_CODE_BLOCK},pn=${LAZY_MERMAID};`;
    const result = transformStreamdownSource(code);

    expect(result).not.toBeNull();
    expect(result).toContain('__SD_CodeBlock');
    expect(result).toContain('__SD_Mermaid');
    expect(result).not.toContain('lazy(');
  });

  it('preserves surrounding code', () => {
    const code = `var x=1;var mn=${LAZY_CODE_BLOCK};var y=2;`;
    const result = transformStreamdownSource(code);

    expect(result).not.toBeNull();
    expect(result).toContain('var x=1;');
    expect(result).toContain('var y=2;');
  });

  it('handles different hash suffixes in filenames', () => {
    const code = `var mn=lazy(()=>import('./code-block-ABCD1234.js').then(e=>({default:e.CodeBlock})));`;
    const result = transformStreamdownSource(code);

    expect(result).not.toBeNull();
    expect(result).toContain(
      `import {CodeBlock as __SD_CodeBlock} from './code-block-ABCD1234.js';`
    );
    expect(result).toContain('var mn=__SD_CodeBlock;');
  });

  it('handles different variable names in .then callback', () => {
    const code = `var mn=lazy(()=>import('./code-block-OCS4YCEC.js').then(t=>({default:t.CodeBlock})));`;
    const result = transformStreamdownSource(code);

    expect(result).not.toBeNull();
    expect(result).toContain('__SD_CodeBlock');
    expect(result).not.toContain('lazy(');
  });

  it('transforms the real Streamdown source (canary)', () => {
    const streamdownEntry = import.meta.resolve('streamdown');
    const distributionDirectory = path.dirname(fileURLToPath(streamdownEntry));
    const chunkFile = readdirSync(distributionDirectory).find(
      (f) => f.startsWith('chunk-') && f.endsWith('.js')
    );

    expect(chunkFile).toBeDefined();
    const source = readFileSync(path.join(distributionDirectory, chunkFile!), 'utf8');
    const result = transformStreamdownSource(source);

    expect(result).not.toBeNull();
    expect(result).toContain('__SD_CodeBlock');
    expect(result).toContain('__SD_Mermaid');
    expect(result).not.toMatch(/lazy\(\(\)=>import\('[^']*code-block/);
    expect(result).not.toMatch(/lazy\(\(\)=>import\('[^']*mermaid/);
  });
});
