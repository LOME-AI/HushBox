import { describe, it, expect } from 'vitest';
import { scanResourceErrors, type ScanEntry } from './resource-scan.js';

function entry(test: string, text: string): ScanEntry {
  return { test, text };
}

describe('scanResourceErrors', () => {
  it('returns no hits for empty input', () => {
    const result = scanResourceErrors([]);
    expect(result.totalHits).toBe(0);
    expect(result.categories).toEqual([]);
  });

  it('ignores empty error text', () => {
    const result = scanResourceErrors([entry('a', ''), entry('b', '   ')]);
    // whitespace-only still has length, but matches nothing
    expect(result.totalHits).toBe(0);
  });

  it('detects pthread_create EAGAIN as a process/thread limit', () => {
    const result = scanResourceErrors([
      entry('t1', 'pthread_create: Resource temporarily unavailable (11)'),
    ]);
    expect(result.categories[0]?.name).toBe('process/thread limit');
    expect(result.categories[0]?.count).toBe(1);
    expect(result.categories[0]?.tests).toEqual(['t1']);
    expect(result.totalHits).toBe(1);
  });

  it('detects EMFILE / too many open files', () => {
    const result = scanResourceErrors([entry('t', 'Error: EMFILE: too many open files')]);
    expect(result.categories[0]?.name).toBe('open-file limit');
  });

  it('detects out-of-memory variants', () => {
    for (const text of ['Cannot allocate memory', 'ENOMEM', 'out of memory', 'std::bad_alloc']) {
      const result = scanResourceErrors([entry('t', text)]);
      expect(result.categories[0]?.name).toBe('out of memory');
    }
  });

  it('detects SIGKILL / signal 9 as process killed', () => {
    expect(scanResourceErrors([entry('t', 'process exited SIGKILL')]).categories[0]?.name).toBe(
      'process killed'
    );
    expect(scanResourceErrors([entry('t', 'received signal 9')]).categories[0]?.name).toBe(
      'process killed'
    );
  });

  it('detects browser-crash signatures', () => {
    const texts = [
      'Target page, context or browser has been closed',
      'Page crashed',
      'browserContext.newPage: Target page, context or browser has been closed',
      'browserType.launch: Target page, context or browser has been closed',
    ];
    for (const text of texts) {
      const result = scanResourceErrors([entry('t', text)]);
      expect(result.categories.some((c) => c.name === 'browser crash')).toBe(true);
    }
  });

  it('dedupes tests within a category but counts every matching entry', () => {
    const result = scanResourceErrors([
      entry('t1', 'pthread_create failed'),
      entry('t1', 'pthread_create failed again'),
      entry('t2', 'EAGAIN'),
    ]);
    const cat = result.categories.find((c) => c.name === 'process/thread limit');
    expect(cat?.count).toBe(3);
    expect(cat?.tests.toSorted()).toEqual(['t1', 't2']);
  });

  it('caps the tests list at 10 distinct entries', () => {
    const entries = Array.from({ length: 15 }, (_, index) => entry(`t${String(index)}`, 'EAGAIN'));
    const cat = scanResourceErrors(entries).categories[0];
    expect(cat?.count).toBe(15);
    expect(cat?.tests).toHaveLength(10);
  });

  it('sorts categories by hit count descending', () => {
    const result = scanResourceErrors([
      entry('a', 'EAGAIN'),
      entry('b', 'EAGAIN'),
      entry('c', 'too many open files'),
    ]);
    expect(result.categories).toHaveLength(2);
    expect(result.categories[0]?.name).toBe('process/thread limit');
    expect(result.categories[0]?.count ?? 0).toBeGreaterThanOrEqual(
      result.categories[1]?.count ?? 0
    );
  });
});
