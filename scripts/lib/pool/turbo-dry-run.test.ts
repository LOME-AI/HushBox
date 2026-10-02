import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseTaskRuns } from './turbo-dry-run.js';

const REPO_ROOT = '/repo';

const dryRun = JSON.stringify({
  tasks: [
    {
      taskId: '@hushbox/api#lint',
      package: '@hushbox/api',
      directory: 'apps/api',
      cache: { status: 'MISS' },
    },
    {
      taskId: '@hushbox/db#lint',
      package: '@hushbox/db',
      directory: 'packages/db',
      cache: { status: 'HIT' },
    },
    {
      taskId: '@hushbox/sandbox#fetch-pyodide',
      package: '@hushbox/sandbox',
      directory: 'apps/sandbox',
      cache: { status: 'MISS' },
    },
    {
      taskId: '@hushbox/e2e#lint',
      package: '@hushbox/e2e',
      directory: 'e2e',
      command: '<NONEXISTENT>',
      cache: { status: 'MISS' },
    },
  ],
});

describe('parseTaskRuns', () => {
  it('keeps cache-missed tasks of the named task with absolute directories, skipping scriptless tasks', () => {
    const missed = parseTaskRuns(dryRun, REPO_ROOT, 'lint');
    expect([...missed.entries()]).toEqual([['@hushbox/api', path.resolve(REPO_ROOT, 'apps/api')]]);
  });

  it('matches only the named task', () => {
    expect(parseTaskRuns(dryRun, REPO_ROOT, 'fetch-pyodide').size).toBe(1);
    expect(parseTaskRuns(dryRun, REPO_ROOT, 'test').size).toBe(0);
  });

  it('includes cache hits when asked, still skipping scriptless tasks', () => {
    const all = parseTaskRuns(dryRun, REPO_ROOT, 'lint', { includeCacheHits: true });
    expect([...all.keys()]).toEqual(['@hushbox/api', '@hushbox/db']);
  });

  it('returns an empty map when every task hit cache', () => {
    const allHit = JSON.stringify({
      tasks: [{ taskId: '@hushbox/api#lint', package: '@hushbox/api', cache: { status: 'HIT' } }],
    });
    expect(parseTaskRuns(allHit, REPO_ROOT, 'lint').size).toBe(0);
  });

  it('tolerates a report with no tasks array', () => {
    expect(parseTaskRuns('{}', REPO_ROOT, 'lint').size).toBe(0);
  });
});
