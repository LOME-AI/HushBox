import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { censusCitations, countLines } from './census.ts';
import { parseFinding } from './parse.ts';
import type { CitationCensus } from './census.ts';
import type { LoadedFinding } from './store.ts';
import type { FindingState } from './types.ts';

/**
 * A working tree small enough to reason about. `pass.ts` is newline-terminated
 * and ten lines long, which is the case every wrong census in this corpus's
 * history mis-measured.
 */
const TEN_LINES = Array.from({ length: 10 }, (_, line) => `line ${String(line + 1)}`);

const REPO_FILES: Readonly<Record<string, string>> = {
  'apps/api/src/lib/pass.ts': `${TEN_LINES.join('\n')}\n`,
  'apps/api/src/slices/chat/routes.ts': 'a\nb\nc\nd\ne',
  'apps/api/src/empty.ts': '',
  'apps/web/src/lib/twice.ts': 'x\n',
  'apps/admin/src/lib/twice.ts': 'x\n',
  'packages/ui/src/only.ts': 'x\n',
};

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'docket-census-'));
  await Promise.all(
    Object.entries(REPO_FILES).map(async ([relative, text]) => {
      const full = path.join(root, relative);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, text, 'utf8');
    })
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function finding(
  id: string,
  body: string,
  extra: { readonly title?: string; readonly state?: FindingState } = {}
): LoadedFinding {
  const text = [
    '---',
    `id: "${id}"`,
    `title: "${extra.title ?? 'A finding'}"`,
    'severity: "low"',
    'kind: "defect"',
    'status: "live"',
    'status_note: null',
    'area: "apps/api"',
    'needs_ruling: true',
    'needs_options: false',
    'warning: false',
    'related: []',
    'group: null',
    'dedicated: false',
    `state: "${extra.state ?? 'open'}"`,
    'ruling: null',
    'denial: null',
    'history: []',
    'questions: []',
    'progress:',
    '  status: "not-started"',
    '  updated: null',
    '  verified: false',
    '  notes: []',
    '---',
    '',
    body,
    '',
  ].join('\n');

  const parsed = parseFinding(text, `${id}.md`);
  if (!parsed.ok) throw new Error(`fixture ${id} does not parse: ${JSON.stringify(parsed.issues)}`);
  return { finding: parsed.value, path: `findings/${id}.md`, text, hash: id };
}

async function census(
  findings: readonly LoadedFinding[],
  states?: readonly FindingState[]
): Promise<CitationCensus> {
  return states === undefined
    ? censusCitations({ root, findings })
    : censusCitations({ root, findings, states });
}

describe('a citation the console serves', () => {
  it('lives when its range ends at the last line of the file', async () => {
    const result = await census([finding('A-1', 'Read `apps/api/src/lib/pass.ts:4-10`.')]);

    expect(result.dead).toEqual([]);
  });

  it('is dead when its range ends one line past a newline-terminated file', async () => {
    const result = await census([finding('A-1', 'Read `apps/api/src/lib/pass.ts:11`.')]);

    expect(result.dead).toMatchObject([{ reason: 'past-end-of-file', fileLines: 10 }]);
  });

  it('is dead when its start is in range and only its end overruns', async () => {
    const result = await census([finding('A-1', 'Read `apps/api/src/lib/pass.ts:8-14`.')]);

    expect(result.dead).toMatchObject([{ reason: 'past-end-of-file', end: 14, fileLines: 10 }]);
  });

  it('lives when the file it names has no trailing newline', async () => {
    const result = await census([finding('A-1', 'Read `apps/api/src/slices/chat/routes.ts:5`.')]);

    expect(result.dead).toEqual([]);
  });

  it('is dead when it names any line of an empty file', async () => {
    const result = await census([finding('A-1', 'Read `apps/api/src/empty.ts:1`.')]);

    expect(result.dead).toMatchObject([{ reason: 'past-end-of-file', fileLines: 0 }]);
  });

  it('reports the path the console resolved rather than the one written', async () => {
    const result = await census([finding('A-1', 'Read `pass.ts:11`.')]);

    expect(result.dead).toMatchObject([{ resolvedPath: 'apps/api/src/lib/pass.ts' }]);
  });
});

describe('a citation the console refuses', () => {
  it('records a repo-rooted path nothing of its shape survives as a missing file', async () => {
    const result = await census([finding('A-1', 'Read `apps/api/src/gone.ts:4`.')]);

    expect(result.dead).toMatchObject([{ reason: 'missing-file', resolvedPath: null }]);
  });

  it('records a path with exactly one surviving namesake as relocated', async () => {
    const result = await census([finding('A-1', 'Read `apps/api/src/lib/only.ts:1`.')]);

    expect(result.dead).toMatchObject([{ reason: 'relocated' }]);
  });

  it('records a shorthand two files answer to as unresolved', async () => {
    const result = await census([finding('A-1', 'Read `twice.ts:1`.')]);

    expect(result.dead).toMatchObject([{ reason: 'unresolved-path' }]);
  });

  it('records a bare line number with no path before it as having no antecedent', async () => {
    const result = await census([finding('A-1', 'Read `:12`.')]);

    expect(result.dead).toMatchObject([{ reason: 'bare-without-antecedent' }]);
  });

  it('records a range starting before line one as invalid', async () => {
    const result = await census([finding('A-1', 'Read `apps/api/src/lib/pass.ts:0`.')]);

    expect(result.dead).toMatchObject([{ reason: 'invalid-range' }]);
  });

  it('records a range whose end precedes its start as invalid', async () => {
    const result = await census([finding('A-1', 'Read `apps/api/src/lib/pass.ts:8-3`.')]);

    expect(result.dead).toMatchObject([{ reason: 'invalid-range' }]);
  });
});

describe('what the census reads as a citation', () => {
  it('leaves prose code spans out of the count', async () => {
    const result = await census([finding('A-1', 'The `settle()` call.')]);

    expect(result.all.citations).toBe(0);
  });

  it('leaves a citation inside a fenced code block out of the count', async () => {
    const result = await census([
      finding('A-1', ['```ts', 'apps/api/src/gone.ts:4', '```'].join('\n')),
    ]);

    expect(result.all.citations).toBe(0);
  });

  it('resolves a bare line number against the path cited earlier in the finding', async () => {
    const result = await census([finding('A-1', 'Read `apps/api/src/lib/pass.ts:3`, then `:5`.')]);

    expect(result).toMatchObject({ dead: [], all: { citations: 2 } });
  });

  it('carries the explainer path into an option body, as the console does', async () => {
    const result = await census([
      finding(
        'A-1',
        [
          'Read `apps/api/src/lib/pass.ts:3`.',
          '',
          '## Options',
          '',
          '### A — Do it',
          'effort: low · risk: none',
          '',
          'The same file, at `:5`.',
        ].join('\n')
      ),
    ]);

    expect(result).toMatchObject({ dead: [], all: { citations: 2 } });
  });
});

describe('where a dead citation sits', () => {
  it('names the option a dead citation sits in', async () => {
    const result = await census([
      finding(
        'A-1',
        [
          'Nothing here.',
          '',
          '## Options',
          '',
          '### B — Do it',
          'effort: low · risk: none',
          '',
          'Read `apps/api/src/lib/pass.ts:11`.',
        ].join('\n')
      ),
    ]);

    expect(result.dead).toMatchObject([{ zone: 'option', optionId: 'B', clickable: true }]);
  });

  it('counts a dead citation written in a finding title', async () => {
    const result = await census([
      finding('A-1', 'Nothing here.', { title: 'Broken at `apps/api/src/lib/pass.ts:11`' }),
    ]);

    expect(result.dead).toMatchObject([{ zone: 'title', clickable: false }]);
  });

  it('keeps title citations out of the clickable totals', async () => {
    const result = await census([
      finding('A-1', 'Read `apps/api/src/lib/pass.ts:11`.', {
        title: 'Broken at `apps/api/src/lib/pass.ts:12`',
      }),
    ]);

    expect(result).toMatchObject({
      all: { citations: 2, dead: 2, findings: 1 },
      clickable: { citations: 1, dead: 1, findings: 1 },
    });
  });

  it('reads a title against its own text alone, not against the body', async () => {
    const result = await census([
      finding('A-1', 'Read `apps/api/src/lib/pass.ts:3`.', { title: 'Broken at `:5`' }),
    ]);

    expect(result.dead).toMatchObject([{ zone: 'title', reason: 'bare-without-antecedent' }]);
  });

  it('does not let a title path resolve a bare line number in the body', async () => {
    const result = await census([
      finding('A-1', 'Read `:5`.', { title: 'Broken at `apps/api/src/lib/pass.ts:3`' }),
    ]);

    expect(result.dead).toMatchObject([{ zone: 'explainer', reason: 'bare-without-antecedent' }]);
  });
});

describe('scoping the census', () => {
  it('counts every state when given none', async () => {
    const result = await census([
      finding('A-1', 'Read `apps/api/src/lib/pass.ts:11`.'),
      finding('A-2', 'Read `apps/api/src/lib/pass.ts:12`.', { state: 'denied' }),
    ]);

    expect(result.all.dead).toBe(2);
  });

  it('restricts the count to the states it is given', async () => {
    const result = await census(
      [
        finding('A-1', 'Read `apps/api/src/lib/pass.ts:11`.'),
        finding('A-2', 'Read `apps/api/src/lib/pass.ts:12`.', { state: 'denied' }),
      ],
      ['open']
    );

    expect(result.dead).toMatchObject([{ findingId: 'A-1' }]);
  });
});

describe('the totals', () => {
  it('counts the findings holding at least one dead citation, not the citations', async () => {
    const result = await census([
      finding('A-1', 'Read `apps/api/src/lib/pass.ts:11` and `apps/api/src/lib/pass.ts:12`.'),
      finding('A-2', 'Read `apps/api/src/lib/pass.ts:4-10`.'),
    ]);

    expect(result.all).toMatchObject({ citations: 3, dead: 2, findings: 1 });
  });

  it('tallies dead citations by reason', async () => {
    const result = await census([
      finding('A-1', 'Read `apps/api/src/lib/pass.ts:11` and `apps/api/src/gone.ts:4`.'),
    ]);

    expect(result.byReason).toEqual({
      'past-end-of-file': 1,
      'missing-file': 1,
      relocated: 0,
      'unresolved-path': 0,
      'bare-without-antecedent': 0,
      'invalid-range': 0,
    });
  });
});

describe('counting the lines a file really has', () => {
  it('does not count the empty string after a final newline as a line', () => {
    expect(countLines('a\nb\n')).toBe(2);
  });

  it('counts the last line of a file that does not end in a newline', () => {
    expect(countLines('a\nb')).toBe(2);
  });

  it('counts a blank final line that is followed by a newline', () => {
    expect(countLines('a\n\n')).toBe(2);
  });

  it('reads an empty file as having no lines', () => {
    expect(countLines('')).toBe(0);
  });
});
