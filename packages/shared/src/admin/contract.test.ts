import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { ADMIN_OP_EFFECT_CLASSES, defineAdminOpContract } from './contract';

const reason = z.string().trim().min(1);

describe('defineAdminOpContract', () => {
  it('returns the contract unchanged when all invariants hold', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ targetId: z.uuid(), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
      target: null,
      allowedRoles: ['operator'],
    });
    expect(contract.name).toBe('thing.do');
    expect(contract.inverse).toBe('thing.undo');
  });

  it('rejects a durable mutation without an inverse', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), reason }),
        inverse: null,
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/durable/);
  });

  it('rejects an ephemeral mutation that names an inverse', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), reason }),
        inverse: 'thing.undo',
        effectClass: 'ephemeral',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/ephemeral/);
  });

  it('rejects a system-owned mutation that names an inverse', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), reason }),
        inverse: 'thing.undo',
        effectClass: 'system-owned',
        systemOwnedReason: 'resumes work the system already owed',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/system-owned/);
  });

  it('rejects a system-owned mutation that states no reason', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), reason }),
        inverse: null,
        effectClass: 'system-owned',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/systemOwnedReason/);
  });

  it('rejects a system-owned mutation whose stated reason is blank', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), reason }),
        inverse: null,
        effectClass: 'system-owned',
        systemOwnedReason: '   ',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/systemOwnedReason/);
  });

  // Enumerated from the declared class set rather than from a named class, so
  // a class added to `ADMIN_OP_EFFECT_CLASSES` must earn its refusal here. The
  // catalog projection copies whatever a contract states, so a reason accepted
  // on the wrong class would be rendered to the operator as a justification.
  it.each(ADMIN_OP_EFFECT_CLASSES.filter((effectClass) => effectClass !== 'system-owned'))(
    'rejects a stated system-owned reason on effect class %s',
    (effectClass) => {
      expect(() =>
        defineAdminOpContract({
          name: 'thing.do',
          title: 'Do thing',
          kind: 'mutation',
          input: z.object({ targetId: z.uuid(), reason }),
          inverse: effectClass === 'durable' ? 'thing.undo' : null,
          effectClass,
          systemOwnedReason: 'resumes work the system already owed',
          target: null,
          allowedRoles: ['operator'],
        })
      ).toThrow(/systemOwnedReason/);
    }
  );

  it('keeps a system-owned mutation that states its reason and names no inverse', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ targetId: z.uuid(), reason }),
      inverse: null,
      effectClass: 'system-owned',
      systemOwnedReason: 'resumes work the system already owed',
      target: null,
      allowedRoles: ['operator'],
    });
    expect(contract.systemOwnedReason).toBe('resumes work the system already owed');
  });

  it('rejects a mutation whose input lacks reason', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid() }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/reason/);
  });

  it('rejects a mutation whose reason accepts the empty string', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), reason: z.string() }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/reason/);
  });

  it('rejects a nested (non-flat) input object', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.object({ inner: z.string() }), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a nested object hidden behind a default', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          nested: z.object({ inner: z.string() }).default({ inner: 'x' }),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('accepts a flat field carrying a default', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ mode: z.string().default('safe'), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
      target: null,
      allowedRoles: ['operator'],
    });
    expect(contract.input.parse({ reason: 'r' }).mode).toBe('safe');
  });

  it('rejects a nested object hidden behind optional', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.object({ inner: z.string() }).optional(), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a nested object hidden inside a union', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          nested: z.union([z.object({ inner: z.string() }), z.string()]),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('accepts a union of scalar options', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ mode: z.union([z.string(), z.number()]), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
      target: null,
      allowedRoles: ['operator'],
    });
    expect(contract.input.parse({ mode: 'x', reason: 'r' }).mode).toBe('x');
  });

  it('rejects a record field', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.record(z.string(), z.string()), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a tuple field', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.tuple([z.string(), z.number()]), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a nested object hidden inside a pipe', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          nested: z.object({ inner: z.string() }).pipe(z.object({ inner: z.string() })),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('accepts a scalar transform pipe field (the NanoUSD shape)', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ amount: z.string().transform(BigInt), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
      target: null,
      allowedRoles: ['operator'],
    });
    expect(contract.input.parse({ amount: '5', reason: 'r' }).amount).toBe(5n);
  });

  it('rejects a nested object hidden behind z.lazy', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.lazy(() => z.object({ inner: z.string() })), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects even a scalar z.lazy — lazy schemas cannot be statically inspected', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ mode: z.lazy(() => z.string()), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a nested object inside an intersection', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          nested: z.intersection(z.object({ inner: z.string() }), z.object({ other: z.string() })),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('accepts an intersection of scalar schemas', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ mode: z.intersection(z.string(), z.string().min(1)), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
      target: null,
      allowedRoles: ['operator'],
    });
    expect(contract.input.parse({ mode: 'x', reason: 'r' }).mode).toBe('x');
  });

  it('rejects a nested object hidden behind readonly', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.object({ inner: z.string() }).readonly(), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('accepts a flat readonly scalar', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ mode: z.string().readonly(), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
      target: null,
      allowedRoles: ['operator'],
    });
    expect(contract.input.parse({ mode: 'x', reason: 'r' }).mode).toBe('x');
  });

  it('rejects a nested object hidden behind catch', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          // eslint-disable-next-line promise/prefer-await-to-then -- zod's schema .catch(), not a Promise
          nested: z.object({ inner: z.string() }).catch({ inner: 'x' }),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('accepts a flat scalar with catch', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      // eslint-disable-next-line promise/prefer-await-to-then -- zod's schema .catch(), not a Promise
      input: z.object({ mode: z.string().catch('safe'), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
      target: null,
      allowedRoles: ['operator'],
    });
    expect(contract.input.parse({ mode: 1 as unknown as string, reason: 'r' }).mode).toBe('safe');
  });

  it('rejects a nested object hidden behind nonoptional', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          nested: z.object({ inner: z.string() }).optional().nonoptional(),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a nested object hidden behind prefault', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          nested: z.object({ inner: z.string() }).prefault({ inner: 'x' }),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a map field', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.map(z.string(), z.string()), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a set field', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.set(z.string()), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('accepts a repeatable group of flat scalars', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({
        items: z
          .array(
            z.object({
              label: z.string().min(1),
              count: z.number(),
              active: z.boolean(),
              level: z.enum(['low', 'high']),
              note: z.string().optional(),
            })
          )
          .max(20),
        reason,
      }),
      inverse: 'thing.undo',
      effectClass: 'durable',
      target: null,
      allowedRoles: ['operator'],
    });
    expect(
      contract.input.parse({
        items: [{ label: 'a', count: 1, active: true, level: 'low' }],
        reason: 'r',
      }).items
    ).toHaveLength(1);
  });

  it('accepts a repeatable group hidden behind optional', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({
        items: z.array(z.object({ label: z.string() })).optional(),
        reason,
      }),
      inverse: 'thing.undo',
      effectClass: 'durable',
      target: null,
      allowedRoles: ['operator'],
    });
    expect(contract.input.parse({ reason: 'r' }).items).toBeUndefined();
  });

  it('rejects a nested object inside a group', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          items: z.array(z.object({ inner: z.object({ deep: z.string() }) })),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects an array inside a group', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          items: z.array(z.object({ inner: z.array(z.string()) })),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a group element object with a catchall — undeclared keys smuggle nesting', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          items: z.array(z.object({ label: z.string() }).catchall(z.unknown())),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a loose-object group element — undeclared keys smuggle nesting', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          items: z.array(z.looseObject({ label: z.string() })),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a union inside a group even when its options are scalar', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          items: z.array(z.object({ mode: z.union([z.string(), z.number()]) })),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a doubly-nested array', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          items: z.array(z.array(z.object({ label: z.string() }))),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects an array of scalars — a group element must be an object', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ items: z.array(z.string()), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a z.any() field — arbitrary nested data must not smuggle past the flat law', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ payload: z.any(), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects a z.unknown() field', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ payload: z.unknown(), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('rejects an unrecognized scalar kind — the flat law is fail-closed', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ when: z.date(), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('accepts a scalar-to-scalar pipe', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ mode: z.string().pipe(z.string().min(1)), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
      target: null,
      allowedRoles: ['operator'],
    });
    expect(contract.input.parse({ mode: 'x', reason: 'r' }).mode).toBe('x');
  });

  it('rejects a pipe whose out side is z.any()', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ payload: z.string().pipe(z.any()), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/flat/);
  });

  it('accepts every recognized top-level scalar kind', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({
        id: z.uuid(),
        label: z.string().min(1),
        count: z.number(),
        active: z.boolean(),
        level: z.enum(['low', 'high']),
        note: z.string().optional(),
        reason,
      }),
      inverse: 'thing.undo',
      effectClass: 'durable',
      target: null,
      allowedRoles: ['operator'],
    });
    expect(contract.name).toBe('thing.do');
  });

  it('rejects a mutation whose reason accepts a whitespace-only string', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), reason: z.string().min(1) }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator'],
      })
    ).toThrow(/reason/);
  });
  it('keeps a target declaration naming a required string input field', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ targetId: z.uuid(), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
      target: { type: 'thing', field: 'targetId' },
      allowedRoles: ['operator'],
    });
    expect(contract.target).toEqual({ type: 'thing', field: 'targetId' });
  });

  it('rejects a target declaration naming a field the input does not have', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: { type: 'thing', field: 'absentId' },
        allowedRoles: ['operator'],
      })
    ).toThrow(/target field/);
  });

  it('rejects a target declaration naming a non-string field', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), count: z.number(), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: { type: 'thing', field: 'count' },
        allowedRoles: ['operator'],
      })
    ).toThrow(/target field/);
  });

  it('rejects a target declaration naming an optional field', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid().optional(), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: { type: 'thing', field: 'targetId' },
        allowedRoles: ['operator'],
      })
    ).toThrow(/target field/);
  });
});

/**
 * The declaration a money cap makes is carried into the contract's TYPE, not
 * only its value, so a consumer can oblige a capped op at build time. The pin
 * is each annotation below; `pnpm typecheck` is the instrument. No runtime test
 * can stand in for it — both shapes transpile to the same JavaScript, so the
 * expectations here would stay green with the guarantee deleted.
 */
describe('defineAdminOpContract guardrail declaration (compile-time)', () => {
  const CAP = 1_000_000_000n;

  const capped = defineAdminOpContract({
    name: 'thing.capped',
    title: 'Capped thing',
    kind: 'mutation',
    input: z.object({ targetId: z.uuid(), reason }),
    inverse: 'thing.undo',
    effectClass: 'durable',
    target: { type: 'thing', field: 'targetId' },
    allowedRoles: ['operator'],
    guardrails: { maxAmountNanoUsd: CAP },
  });

  const uncapped = defineAdminOpContract({
    name: 'thing.uncapped',
    title: 'Uncapped thing',
    kind: 'mutation',
    input: z.object({ targetId: z.uuid(), reason }),
    inverse: 'thing.undo',
    effectClass: 'durable',
    target: { type: 'thing', field: 'targetId' },
    allowedRoles: ['operator'],
  });

  it('carries a declared money cap into the returned type', () => {
    const declared: { readonly maxAmountNanoUsd: bigint } = capped.guardrails;

    expect(declared.maxAmountNanoUsd).toBe(CAP);
  });

  it('keeps an undeclared guardrail out of the returned type', () => {
    // @ts-expect-error -- an op declaring no guardrail has no cap to read
    const declared: { readonly maxAmountNanoUsd: bigint } = uncapped.guardrails;

    expect(declared).toBeUndefined();
  });

  it('rejects a misspelled guardrails key rather than reading it as no cap', () => {
    const misspelled = defineAdminOpContract({
      name: 'thing.misspelled',
      title: 'Misspelled thing',
      kind: 'mutation',
      input: z.object({ targetId: z.uuid(), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
      target: { type: 'thing', field: 'targetId' },
      allowedRoles: ['operator'],
      // @ts-expect-error -- 'guardrail' is not a contract key; accepting it would ship an uncapped op
      guardrail: { maxAmountNanoUsd: CAP },
    });

    expect(misspelled.guardrails).toBeUndefined();
  });
});

/**
 * `allowedRoles` is the contract's half of the read-only-role design: the
 * route map refuses a viewer before any handler, and this refuses at module
 * load a mutation a viewer could ever be listed on, so the mistake cannot
 * reach a deploy to be caught at call time.
 */
describe('defineAdminOpContract allowedRoles', () => {
  it('throws when a mutation lists a role other than operator', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
        target: null,
        allowedRoles: ['operator', 'growth-viewer'],
      })
    ).toThrow(/allowedRoles/);
  });

  it('accepts a read that lists a non-operator role', () => {
    const contract = defineAdminOpContract({
      name: 'thing.read',
      title: 'Read thing',
      kind: 'read',
      input: z.object({}),
      inverse: null,
      effectClass: 'ephemeral',
      target: null,
      allowedRoles: ['operator', 'growth-viewer'],
    });

    expect(contract.allowedRoles).toStrictEqual(['operator', 'growth-viewer']);
  });

  it('throws on a role the closed set does not carry', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.read',
        title: 'Read thing',
        kind: 'read',
        input: z.object({}),
        inverse: null,
        effectClass: 'ephemeral',
        target: null,
        // @ts-expect-error -- the runtime guard also covers a raw literal that bypassed this constructor's typing
        allowedRoles: ['auditor'],
      })
    ).toThrow(/allowedRoles/);
  });

  it('throws on an empty allowedRoles rather than registering an op nobody may run', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.read',
        title: 'Read thing',
        kind: 'read',
        input: z.object({}),
        inverse: null,
        effectClass: 'ephemeral',
        target: null,
        allowedRoles: [],
      })
    ).toThrow(/allowedRoles/);
  });
});
