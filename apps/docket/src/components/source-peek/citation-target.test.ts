import { describe, it, expect } from 'vitest';
import { buildPathIndex, createCitationAnnotator } from '@hushbox/docket';
import { CITATION_ATTRIBUTES } from '@hushbox/docket/types';
import { citationKey, readCitation } from './citation-target';

function citationElement(attributes: Readonly<Record<string, string>>): HTMLElement {
  const element = document.createElement('code');
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

/** The reader is fed exactly what the renderer writes, with nothing in between. */
function asRendered(markdownHtml: string, files: readonly string[]): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = createCitationAnnotator(buildPathIndex(files))(markdownHtml);
  return host.querySelector('code')!;
}

describe('readCitation over what the renderer actually writes', () => {
  it('reads back a citation the renderer marked, so the two sides cannot drift apart', () => {
    const element = asRendered('<p><code>apps/api/src/lib/jobs/pass.ts:189-202</code></p>', [
      'apps/api/src/lib/jobs/pass.ts',
    ]);

    expect(readCitation(element)).toEqual({
      element,
      path: 'apps/api/src/lib/jobs/pass.ts',
      start: 189,
      end: 202,
    });
  });

  it('reads back a bare line the renderer resolved against the path before it', () => {
    const host = document.createElement('div');
    host.innerHTML = createCitationAnnotator(buildPathIndex(['apps/api/src/platform.ts']))(
      '<p><code>apps/api/src/platform.ts:16</code> and <code>:44</code></p>'
    );
    const second = host.querySelectorAll('code')[1]!;

    expect(readCitation(second)).toMatchObject({ path: 'apps/api/src/platform.ts', start: 44 });
  });

  it('leaves a code span the renderer did not mark unreadable', () => {
    const host = document.createElement('div');
    host.innerHTML = createCitationAnnotator(buildPathIndex([]))(
      '<p><code>db.$client.end()</code></p>'
    );

    expect(readCitation(host.querySelector('code'))).toBeNull();
  });
});

describe('readCitation', () => {
  it('reads the path and the range the renderer marked the span with', () => {
    const element = citationElement({
      [CITATION_ATTRIBUTES.path]: 'apps/api/src/lib/jobs/pass.ts',
      [CITATION_ATTRIBUTES.start]: '189',
      [CITATION_ATTRIBUTES.end]: '202',
    });

    expect(readCitation(element)).toEqual({
      element,
      path: 'apps/api/src/lib/jobs/pass.ts',
      start: 189,
      end: 202,
    });
  });

  it('ignores a code span that is not a citation', () => {
    expect(readCitation(citationElement({}))).toBeNull();
  });

  it('ignores an event with no target at all', () => {
    expect(readCitation(null)).toBeNull();
  });

  it('ignores a target that is not an element', () => {
    expect(readCitation(new EventTarget())).toBeNull();
  });

  it('ignores a citation whose line numbers are not numbers', () => {
    const element = citationElement({
      [CITATION_ATTRIBUTES.path]: 'apps/api/x.ts',
      [CITATION_ATTRIBUTES.start]: 'sixty-eight',
      [CITATION_ATTRIBUTES.end]: 'sixty-eight',
    });

    expect(readCitation(element)).toBeNull();
  });
});

describe('citationKey', () => {
  it('keys a cached window by path and range', () => {
    expect(citationKey({ path: 'apps/api/x.ts', start: 68, end: 68 })).toBe('apps/api/x.ts:68-68');
  });

  it('separates two ranges in the same file', () => {
    expect(citationKey({ path: 'a.ts', start: 1, end: 2 })).not.toBe(
      citationKey({ path: 'a.ts', start: 1, end: 3 })
    );
  });
});
