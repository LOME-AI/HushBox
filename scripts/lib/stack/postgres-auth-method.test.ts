import { describe, it, expect, vi } from 'vitest';
import {
  ensurePostgresAcceptsPassword,
  rulesBlockingPipelinedConnect,
  type HostAuthRule,
  type PostgresAuthMethodDeps,
} from './postgres-auth-method.js';

/** What the image writes on a volume the compose setting reached: the catch-all asks for a password. */
const REPAIRED: HostAuthRule[] = [
  { lineNumber: 119, authMethod: 'trust' },
  { lineNumber: 128, authMethod: 'password' },
];

/** What a volume initialised before that setting carries: the catch-all asks for SASL. */
const BROKEN: HostAuthRule[] = [
  { lineNumber: 119, authMethod: 'trust' },
  { lineNumber: 128, authMethod: 'scram-sha-256' },
];

/**
 * A stub cluster whose rewrite actually moves the state the next read observes,
 * so a test can ask what a second bring-up over the same volume does.
 */
function cluster(initial: readonly HostAuthRule[]): {
  deps: PostgresAuthMethodDeps;
  readHostRules: ReturnType<typeof vi.fn>;
  acceptPasswordOn: ReturnType<typeof vi.fn>;
  report: ReturnType<typeof vi.fn>;
  rules: () => readonly HostAuthRule[];
} {
  let rules: readonly HostAuthRule[] = initial;
  const readHostRules = vi.fn(() => Promise.resolve(rules));
  const acceptPasswordOn = vi.fn((blocking: readonly HostAuthRule[]) => {
    const lines = new Set(blocking.map((rule) => rule.lineNumber));
    rules = rules.map((rule) =>
      lines.has(rule.lineNumber) ? { ...rule, authMethod: 'password' } : rule
    );
    return Promise.resolve();
  });
  const report = vi.fn();
  return {
    deps: { readHostRules, acceptPasswordOn, report },
    readHostRules,
    acceptPasswordOn,
    report,
    rules: () => rules,
  };
}

describe('rulesBlockingPipelinedConnect', () => {
  it('names a rule whose method asks for SASL', () => {
    expect(rulesBlockingPipelinedConnect(BROKEN)).toEqual([
      { lineNumber: 128, authMethod: 'scram-sha-256' },
    ]);
  });

  it('names a rule whose method asks for an MD5 digest', () => {
    expect(rulesBlockingPipelinedConnect([{ lineNumber: 4, authMethod: 'md5' }])).toEqual([
      { lineNumber: 4, authMethod: 'md5' },
    ]);
  });

  it('leaves a cleartext-password rule alone', () => {
    expect(rulesBlockingPipelinedConnect([{ lineNumber: 128, authMethod: 'password' }])).toEqual(
      []
    );
  });

  it('leaves a trust rule alone, because it asks for nothing at all', () => {
    expect(rulesBlockingPipelinedConnect([{ lineNumber: 119, authMethod: 'trust' }])).toEqual([]);
  });
});

describe('ensurePostgresAcceptsPassword', () => {
  it('reads once and writes nothing when every rule already accepts a password', async () => {
    const stack = cluster(REPAIRED);

    await ensurePostgresAcceptsPassword(stack.deps);

    expect(stack.readHostRules).toHaveBeenCalledTimes(1);
    expect(stack.acceptPasswordOn).not.toHaveBeenCalled();
  });

  it('stays silent on the path that changed nothing', async () => {
    const stack = cluster(REPAIRED);

    await ensurePostgresAcceptsPassword(stack.deps);

    expect(stack.report).not.toHaveBeenCalled();
  });

  it('leaves a volume initialised with scram-sha-256 accepting a password', async () => {
    const stack = cluster(BROKEN);

    await ensurePostgresAcceptsPassword(stack.deps);

    expect(stack.rules()).toEqual(REPAIRED);
  });

  it('rewrites only the rules that block the connect', async () => {
    const stack = cluster(BROKEN);

    await ensurePostgresAcceptsPassword(stack.deps);

    expect(stack.acceptPasswordOn).toHaveBeenCalledWith([
      { lineNumber: 128, authMethod: 'scram-sha-256' },
    ]);
  });

  it('says what it repaired, so a bring-up that changed the cluster is not silent', async () => {
    const stack = cluster(BROKEN);

    await ensurePostgresAcceptsPassword(stack.deps);

    expect(stack.report).toHaveBeenCalledWith(expect.stringContaining('scram-sha-256'));
  });

  it('changes nothing on a second run over the volume it just repaired', async () => {
    const stack = cluster(BROKEN);

    await ensurePostgresAcceptsPassword(stack.deps);
    stack.acceptPasswordOn.mockClear();
    stack.report.mockClear();
    await ensurePostgresAcceptsPassword(stack.deps);

    expect(stack.acceptPasswordOn).not.toHaveBeenCalled();
    expect(stack.report).not.toHaveBeenCalled();
    expect(stack.rules()).toEqual(REPAIRED);
  });

  it('refuses naming the method and pnpm db:reset when the rewrite did not take', async () => {
    const readHostRules = vi.fn(() => Promise.resolve(BROKEN));
    const deps: PostgresAuthMethodDeps = {
      readHostRules,
      acceptPasswordOn: vi.fn(() => Promise.resolve()),
      report: vi.fn(),
    };

    const refusal = ensurePostgresAcceptsPassword(deps);

    await expect(refusal).rejects.toThrow('scram-sha-256');
    await expect(ensurePostgresAcceptsPassword(deps)).rejects.toThrow('pnpm db:reset');
  });

  it('refuses without a rewrite when a blocking rule reports no method to replace', async () => {
    const acceptPasswordOn = vi.fn(() => Promise.resolve());
    const deps: PostgresAuthMethodDeps = {
      readHostRules: vi.fn(() => Promise.resolve([{ lineNumber: 12, authMethod: '' }])),
      acceptPasswordOn,
      report: vi.fn(),
    };

    await expect(ensurePostgresAcceptsPassword(deps)).rejects.toThrow('pnpm db:reset');
    expect(acceptPasswordOn).not.toHaveBeenCalled();
  });

  it('propagates a rewrite failure rather than masking it as a refusal', async () => {
    const stack = cluster(BROKEN);
    stack.acceptPasswordOn.mockRejectedValue(new Error('psql exited 2'));

    await expect(ensurePostgresAcceptsPassword(stack.deps)).rejects.toThrow('psql exited 2');
  });
});
