import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAuditFixture } from '../test-utils/audit-fixture';
import { holdFindingLock } from '../test-utils/hold-lock';
import { runWrite } from './write';
import type { CliDeps } from './deps';
import type { AuditFixture } from '../test-utils/audit-fixture';

/**
 * A real lock held by a real other writer, because the whole point of the retry
 * is what happens against the store's own bounded wait. The store waits five
 * seconds for a live holder before refusing, so these two tests are slow by
 * construction and live apart from the fast write tests.
 */
const HOLD_MS = 5200;
const TIMEOUT_MS = 30_000;

describe('runWrite against a held file', () => {
  let fixture: AuditFixture;
  let err: string[];
  let release: () => Promise<void>;

  beforeEach(async () => {
    fixture = await createAuditFixture();
    err = [];
    release = await holdFindingLock(path.join(fixture.findingsDir, 'AC-1.md'));
  });

  afterEach(async () => {
    await release();
    await fixture.cleanup();
  });

  function deps(): CliDeps {
    return {
      repoRoot: fixture.root,
      out: () => {},
      err: (line) => err.push(line),
    };
  }

  it(
    'retries until the other writer lets go rather than reporting a failure',
    { timeout: TIMEOUT_MS },
    async () => {
      const letGo = setTimeout(() => {
        void release();
      }, HOLD_MS);

      const code = await runWrite(
        { kind: 'note', audit: null, id: 'AC-1', text: 'written after the wait' },
        deps()
      );
      clearTimeout(letGo);

      expect(code).toBe(0);
      expect(err.join('\n')).toContain('retrying');
    }
  );

  it('gives up on a file that is never released', { timeout: TIMEOUT_MS }, async () => {
    const code = await runWrite(
      { kind: 'note', audit: null, id: 'AC-1', text: 'never written' },
      deps(),
      { lockAttempts: 1 }
    );

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('locked');
  });
});
