import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPathIndex, createCitationAnnotator, indexRepositoryFiles } from './citations.ts';
import { CITATION_ATTRIBUTES } from './types.ts';
import type { PathIndex } from './citations.ts';

const INDEX: PathIndex = buildPathIndex([
  'apps/api/src/middleware/pipeline-bindings.ts',
  'apps/api/src/slices/chat/routes.ts',
  'apps/api/src/platform/roadmap/routes.ts',
  'apps/api/src/lib/jobs/pass.ts',
  'apps/api/src/platform.ts',
  'apps/web/src/lib/twice.ts',
  'apps/admin/src/lib/twice.ts',
  'packages/ui/src/components/accessibility/lib/init-script.ts',
  'apps/web/src/routes/share.c.$conversationId.tsx',
  'apps/web/src/routes/share.m.$shareId.tsx',
  'vitest.config.ts',
  'apps/api/vitest.config.ts',
  'turbo.json',
]);

/** What marks a span as the live control, as against the attributes a dead one carries. */
const CONTROL_ATTRIBUTES = [
  CITATION_ATTRIBUTES.path,
  CITATION_ATTRIBUTES.start,
  CITATION_ATTRIBUTES.end,
];

/** The citation attributes alone; the control semantics are asserted on their own. */
function annotationOf(html: string): string {
  const match = /<code ([^>]*)>/.exec(createCitationAnnotator(INDEX)(html));
  return (match?.[1] ?? '')
    .split(' ')
    .filter((attribute) => CONTROL_ATTRIBUTES.some((name) => attribute.startsWith(`${name}=`)))
    .join(' ');
}

/** What a span says, in the reading order, when it is not one the console will serve. */
function noteOf(html: string, index: PathIndex = INDEX): string | null {
  const pattern = new RegExp(`<span ${CITATION_ATTRIBUTES.note}="">([^<]*)</span>`);
  return pattern.exec(createCitationAnnotator(index)(html))?.[1] ?? null;
}

describe('a citation as a control', () => {
  it('announces itself as a control rather than as static code', () => {
    const html = createCitationAnnotator(INDEX)(
      '<p><code>apps/api/src/lib/jobs/pass.ts:189-202</code></p>'
    );

    expect(html).toContain('role="button"');
  });

  it('is named for the copy it performs, against the path it resolved to', () => {
    const html = createCitationAnnotator(INDEX)('<p><code>platform.ts:16-18</code></p>');

    expect(html).toContain('aria-label="Copy apps/api/src/platform.ts:16-18"');
  });

  it('names a single-line citation without a range', () => {
    const html = createCitationAnnotator(INDEX)(
      '<p><code>apps/api/src/middleware/pipeline-bindings.ts:68</code></p>'
    );

    expect(html).toContain('aria-label="Copy apps/api/src/middleware/pipeline-bindings.ts:68"');
  });
});

describe('the citation attribute names', () => {
  it('are the ones the reader is told to look for, not a second copy of them', () => {
    const annotation = annotationOf('<p><code>apps/api/src/lib/jobs/pass.ts:189-202</code></p>');

    expect(annotation).toBe(
      `${CITATION_ATTRIBUTES.path}="apps/api/src/lib/jobs/pass.ts" ` +
        `${CITATION_ATTRIBUTES.start}="189" ${CITATION_ATTRIBUTES.end}="202"`
    );
  });
});

describe('citation annotation shapes', () => {
  it('annotates a path with a single line', () => {
    expect(
      annotationOf('<p><code>apps/api/src/middleware/pipeline-bindings.ts:68</code></p>')
    ).toBe(
      'data-citation-path="apps/api/src/middleware/pipeline-bindings.ts" data-citation-start="68" data-citation-end="68"'
    );
  });

  it('annotates a path with a range', () => {
    expect(annotationOf('<p><code>apps/api/src/slices/chat/routes.ts:1878-1900</code></p>')).toBe(
      'data-citation-path="apps/api/src/slices/chat/routes.ts" data-citation-start="1878" data-citation-end="1900"'
    );
  });

  it('anchors a multi-range citation on its first range', () => {
    expect(annotationOf('<p><code>apps/api/src/lib/jobs/pass.ts:189-202,268</code></p>')).toBe(
      'data-citation-path="apps/api/src/lib/jobs/pass.ts" data-citation-start="189" data-citation-end="202"'
    );
  });

  it('resolves a bare basename that matches exactly one file', () => {
    expect(annotationOf('<p><code>platform.ts:16-18</code></p>')).toBe(
      'data-citation-path="apps/api/src/platform.ts" data-citation-start="16" data-citation-end="18"'
    );
  });

  it('leaves an ambiguous basename as plain text', () => {
    const html = '<p><code>twice.ts:16</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('leaves a basename a repo-root file shares with a nested one as plain text', () => {
    const html = '<p><code>vitest.config.ts:82-119</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('leaves an unknown basename as plain text', () => {
    const html = '<p><code>nowhere.ts:16</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('resolves a bare line against the last path in the same body', () => {
    const html =
      '<p><code>apps/api/src/slices/chat/routes.ts:1878</code> and later <code>:610</code></p>';
    const annotated = createCitationAnnotator(INDEX)(html);
    expect(annotated).toContain(
      '<code data-citation-path="apps/api/src/slices/chat/routes.ts" data-citation-start="610" data-citation-end="610" role="button" aria-label="Copy apps/api/src/slices/chat/routes.ts:610">:610</code>'
    );
  });

  it('leaves a bare line with no earlier path as plain text', () => {
    const html = '<p><code>:610</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('carries the resolved basename forward as the last path', () => {
    const html = '<p><code>platform.ts:16</code> then <code>:99</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toContain(
      '<code data-citation-path="apps/api/src/platform.ts" data-citation-start="99" data-citation-end="99" role="button" aria-label="Copy apps/api/src/platform.ts:99">:99</code>'
    );
  });
});

describe('a route file named for its router parameter', () => {
  it('resolves the repo-rooted path of one', () => {
    expect(
      annotationOf('<p><code>apps/web/src/routes/share.c.$conversationId.tsx:41</code></p>')
    ).toBe(
      'data-citation-path="apps/web/src/routes/share.c.$conversationId.tsx" data-citation-start="41" data-citation-end="41"'
    );
  });

  it('resolves a shorthand ending in one', () => {
    expect(annotationOf('<p><code>routes/share.m.$shareId.tsx:18</code></p>')).toBe(
      'data-citation-path="apps/web/src/routes/share.m.$shareId.tsx" data-citation-start="18" data-citation-end="18"'
    );
  });

  it('leaves a span that is only citation-shaped because of its dollar as plain text', () => {
    const html = '<p><code>$5:1</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('does not break the bare-line chain on a dollar-bearing span naming no file', () => {
    const html = '<p><code>platform.ts:16</code> then <code>$0.50</code> then <code>:99</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toContain(
      '<code data-citation-path="apps/api/src/platform.ts" data-citation-start="99" data-citation-end="99" role="button" aria-label="Copy apps/api/src/platform.ts:99">:99</code>'
    );
  });
});

describe('a repo-rooted path with nothing at it', () => {
  it('stays plain text when one file matches its ending, rather than reading as deleted', () => {
    expect(annotationOf('<p><code>packages/ui/src/lib/init-script.ts:12</code></p>')).toBe('');
  });

  it('names the one file that matches its ending', () => {
    expect(noteOf('<p><code>packages/ui/src/lib/init-script.ts:12</code></p>')).toBe(
      'This path is not in the working tree. The only file matching its ending is ' +
        'packages/ui/src/components/accessibility/lib/init-script.ts.'
    );
  });

  it('takes the deepest ending any file matches, so a re-rooted path passes its basename', () => {
    expect(
      noteOf('<p><code>apps/api/src/slices/platform/roadmap/routes.ts:10</code></p>')
    ).toContain('apps/api/src/platform/roadmap/routes.ts.');
  });

  it('names a file that now sits at the repository root', () => {
    expect(noteOf('<p><code>apps/api/turbo.json:3</code></p>')).toContain('is turbo.json.');
  });

  it('says nothing about where it went when two files match its ending', () => {
    const html = '<p><code>apps/api/src/adapters/twice.ts:16</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('is no longer a live citation when nothing of its shape is in the tree', () => {
    expect(annotationOf('<p><code>apps/api/src/slices/chat/deleted.ts:4</code></p>')).toBe('');
  });

  it('says its target is gone when nothing of its shape is in the tree', () => {
    expect(noteOf('<p><code>apps/api/src/slices/chat/deleted.ts:4</code></p>')).toBe(
      'This path is not in the working tree.'
    );
  });

  it('marks the span itself as one the console will not serve, so it can be seen to be dead', () => {
    expect(
      createCitationAnnotator(INDEX)('<p><code>apps/api/src/slices/chat/deleted.ts:4</code></p>')
    ).toContain(`<code ${CITATION_ATTRIBUTES.dead}="">`);
  });

  it('states why in the reading order rather than on hover alone', () => {
    const html = createCitationAnnotator(INDEX)(
      '<p><code>apps/api/src/slices/chat/deleted.ts:4</code></p>'
    );

    expect(html).not.toContain('title=');
    expect(html).toContain(
      `<span ${CITATION_ATTRIBUTES.note}="">This path is not in the working tree.</span>`
    );
  });

  it('keeps the text of a citation whose target is gone, so the trail survives', () => {
    expect(
      createCitationAnnotator(INDEX)('<p><code>apps/api/src/slices/chat/deleted.ts:4</code></p>')
    ).toContain('>apps/api/src/slices/chat/deleted.ts:4</code>');
  });

  it('does not carry an earlier path past a citation whose target is gone', () => {
    const html =
      '<p><code>platform.ts:16</code> then <code>apps/api/src/slices/chat/deleted.ts:4</code> then <code>:99</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toContain('<code>:99</code>');
  });

  it('passes over a file whose ending matches only inside a segment', () => {
    const index = buildPathIndex([
      'packages/ui/src/components/accessibility/lib/init-script.ts',
      'packages/ui/src/mylib/init-script.ts',
    ]);
    expect(noteOf('<p><code>packages/ui/src/lib/init-script.ts:12</code></p>', index)).toContain(
      'is packages/ui/src/components/accessibility/lib/init-script.ts.'
    );
  });

  it('escapes the path it names, which comes off the filesystem rather than through the pattern', () => {
    const index = buildPathIndex(['apps/we<ird&/lib/init-script.ts']);
    expect(
      createCitationAnnotator(index)('<p><code>apps/ui/src/lib/init-script.ts:12</code></p>')
    ).toContain('apps/we&lt;ird&amp;/lib/init-script.ts');
  });

  it('marks a span whose file moved as one the console will not serve either', () => {
    expect(
      createCitationAnnotator(INDEX)('<p><code>packages/ui/src/lib/init-script.ts:12</code></p>')
    ).toContain(`<code ${CITATION_ATTRIBUTES.dead}="">`);
  });

  it('does not carry an earlier path past a citation whose file moved', () => {
    const html =
      '<p><code>platform.ts:16</code> then <code>packages/ui/src/lib/init-script.ts:12</code> then <code>:99</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toContain('<code>:99</code>');
  });

  it('does not carry an earlier path past a citation it refused', () => {
    const html =
      '<p><code>platform.ts:16</code> then <code>twice.ts:16</code> then <code>:99</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toContain('<code>:99</code>');
  });
});

describe('a shorthand citation', () => {
  it('resolves to the one tracked file whose path ends with it', () => {
    expect(annotationOf('<p><code>jobs/pass.ts:189-202</code></p>')).toBe(
      'data-citation-path="apps/api/src/lib/jobs/pass.ts" data-citation-start="189" data-citation-end="202"'
    );
  });

  it('matches whole path segments only', () => {
    const html = '<p><code>at/routes.ts:1878</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('stays plain text when two files end with it, rather than picking one of them', () => {
    const html = '<p><code>lib/twice.ts:16</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('stays plain text when no file ends with it, rather than reading as deleted', () => {
    const html = '<p><code>domain/nowhere.ts:16</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('stays plain text when its first segment names no directory of the repository', () => {
    const html = '<p><code>abstract/montgomery.js:8</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('carries the path it resolved to forward to a later bare line', () => {
    const html = '<p><code>jobs/pass.ts:189</code> then <code>:268</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toContain(
      '<code data-citation-path="apps/api/src/lib/jobs/pass.ts" data-citation-start="268" data-citation-end="268" role="button" aria-label="Copy apps/api/src/lib/jobs/pass.ts:268">:268</code>'
    );
  });
});

describe('citation annotation boundaries', () => {
  it('ignores text outside a code span', () => {
    const html = '<p>apps/api/src/platform.ts:16 in prose</p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('ignores a fenced code block', () => {
    const html =
      '<pre><code class="language-ts">apps/api/src/platform.ts:16</code></pre><p>after</p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('ignores an unlabelled fenced code block', () => {
    const html = '<pre><code>apps/api/src/platform.ts:16</code></pre>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('does not carry a path out of a fenced block into a later bare line', () => {
    const html = '<pre><code>apps/api/src/platform.ts:16</code></pre><p><code>:99</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('leaves a code span holding prose around the citation alone', () => {
    const html = '<p><code>see apps/api/src/platform.ts:16</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('leaves a code span with no line number alone', () => {
    const html = '<p><code>apps/api/src/platform.ts</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('refuses a citation escaping the repository root', () => {
    const html = '<p><code>../../etc/passwd:1</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('refuses an absolute citation', () => {
    const html = '<p><code>/etc/passwd:1</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('refuses line zero', () => {
    const html = '<p><code>apps/api/src/platform.ts:0</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('refuses a range running backwards', () => {
    const html = '<p><code>apps/api/src/platform.ts:20-10</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toBe(html);
  });

  it('does not carry an earlier path past a citation whose lines make no sense', () => {
    const html =
      '<p><code>platform.ts:16</code> then <code>platform.ts:20-10</code> then <code>:99</code></p>';
    expect(createCitationAnnotator(INDEX)(html)).toContain('<code>:99</code>');
  });
});

describe('indexRepositoryFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'docket-index-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function write(relative: string): Promise<void> {
    const full = path.join(root, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, '');
  }

  it('indexes files by repo-relative path and by basename', async () => {
    await write('apps/api/src/platform.ts');
    const index = await indexRepositoryFiles(root);
    expect(index.paths.has('apps/api/src/platform.ts')).toBe(true);
    expect(index.byBasename.get('platform.ts')).toEqual(['apps/api/src/platform.ts']);
  });

  it('skips build output and dependency directories', async () => {
    await write('node_modules/pkg/index.ts');
    await write('packages/ui/dist/index.js');
    await write('coverage/report.ts');
    await write('.git/config');
    await write('src/kept.ts');
    const index = await indexRepositoryFiles(root);
    expect([...index.paths]).toEqual(['src/kept.ts']);
  });

  it('skips a symlink, so a citation resolves to the file it names', async () => {
    await write('src/real.ts');
    await fs.symlink(path.join(root, 'src/real.ts'), path.join(root, 'src/alias.ts'));
    const index = await indexRepositoryFiles(root);
    expect([...index.paths]).toEqual(['src/real.ts']);
  });

  it('records only directories as repository roots, so a top-level file is not one', async () => {
    await write('turbo.json');
    await write('apps/api/src/platform.ts');
    const index = await indexRepositoryFiles(root);
    expect([...index.roots]).toEqual(['apps']);
  });

  it('records both owners of a duplicated basename', async () => {
    await write('apps/web/src/twice.ts');
    await write('apps/admin/src/twice.ts');
    const index = await indexRepositoryFiles(root);
    expect(index.byBasename.get('twice.ts')).toHaveLength(2);
  });
});
