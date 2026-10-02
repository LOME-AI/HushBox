import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { createAdminOpRegistry, defineAdminOp, defineAdminReadOp } from './registry.js';
import type { AdminOpContract, AnyAdminOpContract } from '@hushbox/shared';
import type { AdminOpImplementation, AdminOpRegistry } from './registry.js';

const reason = z.string().trim().min(1);

interface TestDeps {
  readonly log: string[];
}

interface TestPostDeps {
  readonly notified: string[];
}

function contract(
  name: `${string}.${string}`,
  overrides: Partial<AdminOpContract> = {}
): AdminOpContract {
  // Built as a raw literal (not defineAdminOpContract) so registry tests can
  // craft shapes the shared constructor would refuse.
  return {
    name,
    title: name,
    kind: 'mutation',
    input: z.object({ targetId: z.uuid(), reason }),
    inverse: null,
    effectClass: 'ephemeral',
    target: null,
    allowedRoles: ['operator'],
    ...overrides,
  };
}

function implementationOf(opContract: AdminOpContract): AdminOpImplementation<TestDeps> {
  return defineAdminOp(opContract, {
    execute: (ctx) => {
      ctx.deps.log.push(opContract.name);
      return okAsync({ effects: [{ label: opContract.name }] });
    },
  });
}

describe('createAdminOpRegistry', () => {
  it('rejects a durable mutation whose inverse is not registered (Iron Law)', () => {
    const durable = contract('fixture.mark', { inverse: 'fixture.unmark', effectClass: 'durable' });

    expect(() => createAdminOpRegistry<TestDeps>([implementationOf(durable)])).toThrow(
      /fixture\.mark.*fixture\.unmark.*not registered/
    );
  });

  it('rejects a durable mutation carrying no inverse name at all', () => {
    const lawless = contract('fixture.lawless', { effectClass: 'durable', inverse: null });

    expect(() => createAdminOpRegistry<TestDeps>([implementationOf(lawless)])).toThrow(
      /fixture\.lawless.*inverse/
    );
  });

  it('accepts a durable pair registered together', () => {
    const mark = contract('fixture.mark', { inverse: 'fixture.unmark', effectClass: 'durable' });
    const unmark = contract('fixture.unmark', { inverse: 'fixture.mark', effectClass: 'durable' });

    const registry = createAdminOpRegistry<TestDeps>([
      implementationOf(mark),
      implementationOf(unmark),
    ]);

    expect(registry.get('fixture.mark')?.contract.name).toBe('fixture.mark');
    expect(registry.get('fixture.unmark')?.contract.name).toBe('fixture.unmark');
  });

  it('accepts an ephemeral op registered alone', () => {
    const ping = contract('fixture.ping');

    const registry = createAdminOpRegistry<TestDeps>([implementationOf(ping)]);

    expect(registry.get('fixture.ping')?.contract.effectClass).toBe('ephemeral');
  });

  it('accepts a system-owned op registered alone', () => {
    const redrive = contract('fixture.redrive', {
      effectClass: 'system-owned',
      systemOwnedReason: 'resumes work the system already owed',
    });

    const registry = createAdminOpRegistry<TestDeps>([implementationOf(redrive)]);

    expect(registry.get('fixture.redrive')?.contract.effectClass).toBe('system-owned');
  });

  it('rejects a system-owned mutation stating no reason at all', () => {
    const unstated = contract('fixture.unstated', { effectClass: 'system-owned' });

    expect(() => createAdminOpRegistry<TestDeps>([implementationOf(unstated)])).toThrow(
      /fixture\.unstated.*systemOwnedReason/
    );
  });

  it('rejects a system-owned mutation whose stated reason is blank', () => {
    const blank = contract('fixture.blank', {
      effectClass: 'system-owned',
      systemOwnedReason: '   ',
    });

    expect(() => createAdminOpRegistry<TestDeps>([implementationOf(blank)])).toThrow(
      /fixture\.blank.*systemOwnedReason/
    );
  });

  it('rejects a mutation whose effect class is none the Iron Law recognizes', () => {
    const smuggled = contract('fixture.smuggled', {
      effectClass: 'harmless' as AdminOpContract['effectClass'],
    });

    expect(() => createAdminOpRegistry<TestDeps>([implementationOf(smuggled)])).toThrow(
      /fixture\.smuggled.*harmless/
    );
  });

  it('rejects a duplicate op name', () => {
    const ping = contract('fixture.ping');

    expect(() =>
      createAdminOpRegistry<TestDeps>([implementationOf(ping), implementationOf(ping)])
    ).toThrow(/duplicate.*fixture\.ping/);
  });

  it('returns undefined for an unknown op name', () => {
    const registry = createAdminOpRegistry<TestDeps>([implementationOf(contract('fixture.ping'))]);

    expect(registry.get('fixture.unknown')).toBeUndefined();
  });

  it('rejects a structural impostor registry at the type level (brand mints only here)', () => {
    const impostor = {
      get: (): AdminOpImplementation<TestDeps> | undefined => undefined,
      list: (): readonly AnyAdminOpContract[] => [],
    };
    // @ts-expect-error — a hand-built { get, list } lacks the registry brand; only createAdminOpRegistry (the Iron Law gate) produces AdminOpRegistry
    const branded: AdminOpRegistry<TestDeps> = impostor;

    expect(branded.list()).toEqual([]);
  });

  it('partitions op dependencies so a body reaches only the transaction-scoped half', () => {
    const op = defineAdminOp<TestDeps, z.ZodObject, TestPostDeps>(contract('fixture.split'), {
      // Never invoked: this body exists to be typechecked. The
      // `@ts-expect-error` on the `ctx.deps.notified` read is the load-bearing
      // assertion — move a post-commit dependency back onto the
      // transaction-scoped half and it goes unused, which `tsc` rejects.
      execute: (ctx) => {
        // @ts-expect-error — `notified` is declared on the post-commit half, so it is not on `ctx.deps`; the registered effect's `run` receives it instead
        ctx.deps.notified.push('from the body');
        ctx.registerEphemeral({
          name: 'fixture.split.notify',
          run: (post) => {
            post.notified.push('after commit');
            return Promise.resolve();
          },
        });
        return okAsync({ effects: [] });
      },
    });

    expect(op.contract.name).toBe('fixture.split');
  });

  it('exposes a registered prefill resolver through get', async () => {
    const withPrefill = defineAdminOp<TestDeps, z.ZodObject>(contract('fixture.ping'), {
      execute: () => okAsync({ effects: [] }),
      prefill: (deps) => okAsync({ entries: deps.log.length }),
    });
    const registry = createAdminOpRegistry<TestDeps>([withPrefill]);

    const registered = registry.get('fixture.ping');
    const resolve =
      registered !== undefined && 'prefill' in registered ? registered.prefill : undefined;
    if (resolve === undefined) throw new Error('expected a registered prefill resolver');
    const result = await resolve({ log: ['a'] });

    expect(result._unsafeUnwrap()).toEqual({ entries: 1 });
  });

  it('leaves prefill absent for an op that registers none', () => {
    const registry = createAdminOpRegistry<TestDeps>([implementationOf(contract('fixture.ping'))]);

    const registered = registry.get('fixture.ping');
    expect(registered !== undefined && 'prefill' in registered && registered.prefill).toBeFalsy();
  });

  it('lists every registered contract sorted by name', () => {
    const registry = createAdminOpRegistry<TestDeps>([
      implementationOf(contract('fixture.zeta')),
      implementationOf(contract('fixture.alpha')),
    ]);

    expect(registry.list().map((entry) => entry.name)).toEqual(['fixture.alpha', 'fixture.zeta']);
  });
});

describe('read operations in the registry', () => {
  const readContract = contract('fixture.look', { kind: 'read', input: z.object({}) });

  function readImplementationOf(opContract: AdminOpContract): AdminOpImplementation<TestDeps> {
    return defineAdminReadOp(opContract, {
      read: (ctx) => {
        ctx.deps.log.push(opContract.name);
        return okAsync({ rows: [] });
      },
    });
  }

  it('registers a read body under its contract', () => {
    const registry = createAdminOpRegistry<TestDeps>([readImplementationOf(readContract)]);

    expect(registry.get('fixture.look')?.contract.kind).toBe('read');
  });

  it('asks a read for no inverse, whatever its effect class says', () => {
    const registry = createAdminOpRegistry<TestDeps>([
      readImplementationOf(contract('fixture.look', { kind: 'read', inverse: 'nothing.here' })),
    ]);

    expect(registry.get('fixture.look')).toBeDefined();
  });

  it('refuses a read contract registered with a mutation body', () => {
    expect(() => createAdminOpRegistry<TestDeps>([implementationOf(readContract)])).toThrow(
      /registers no read body/
    );
  });

  it('refuses a mutation contract registered with a read body', () => {
    expect(() =>
      createAdminOpRegistry<TestDeps>([readImplementationOf(contract('fixture.mark'))])
    ).toThrow(/registers no execute body/);
  });
});
