import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  deriveNodeSchemas,
  Edge,
  END_NODE_ID,
  formatTypeTag,
  isAssignable,
  jsonTag,
  listTag,
  MEDIA_TAG_MODALITIES,
  mediaTag,
  NodeId,
  optionalTag,
  PortId,
  PortRef,
  textTag,
  TYPE_TAG_LAWS,
  TypeTagSchema,
  zodFor,
} from './type-tag.ts';
import type { SchemaNameRegistry, TypeTag } from './type-tag.ts';

const MIME_POOL = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'audio/mpeg'] as const;

/**
 * A non-empty mime set drawn from `pool`, in an arbitrary order — the laws
 * below read mime sets as sets, and drawing the order too keeps a reading that
 * quietly depended on it in range.
 */
function mimesFrom(pool: readonly string[]): fc.Arbitrary<readonly [string, ...string[]]> {
  // `minLength: 1` is what the non-empty tuple type states; nothing else can
  // establish it for the compiler.
  return fc
    .shuffledSubarray([...pool], { minLength: 1 })
    .map((mimes) => mimes as [string, ...string[]]);
}

const mimes = mimesFrom(MIME_POOL);

/** The three kinds that carry no inner tag, which is where a recursion bottoms out. */
const leafTags: readonly fc.Arbitrary<TypeTag>[] = [
  fc.constant(textTag()),
  fc
    .tuple(fc.constantFrom(...MEDIA_TAG_MODALITIES), mimes)
    .map(([modality, mimeTypes]) => mediaTag(modality, mimeTypes)),
  fc.constantFrom('answer', 'route', 'summary').map((name) => jsonTag(name)),
];

/** A tag nesting at most `depth` wrappers, every kind equally likely at each level. */
function tagsTo(depth: number): fc.Arbitrary<TypeTag> {
  if (depth === 0) return fc.oneof(...leafTags);
  const inner = tagsTo(depth - 1);
  return fc.oneof(
    ...leafTags,
    inner.map((tag) => optionalTag(tag)),
    inner.map((tag) => listTag(tag))
  );
}

describe('TypeTag grammar', () => {
  it('parses every constructor output', () => {
    const tags = [
      textTag(),
      mediaTag('image', ['image/png']),
      jsonTag('route'),
      optionalTag(textTag()),
      listTag(mediaTag('video', ['video/mp4'])),
    ];
    for (const tag of tags) {
      expect(TypeTagSchema.parse(tag)).toEqual(tag);
    }
  });

  it('rejects bare json at parse (schemaName missing)', () => {
    expect(TypeTagSchema.safeParse({ kind: 'json' }).success).toBe(false);
  });

  it('rejects an empty schemaName', () => {
    expect(TypeTagSchema.safeParse({ kind: 'json', schemaName: '' }).success).toBe(false);
  });

  it('rejects bare json at the constructor', () => {
    expect(() => jsonTag('')).toThrow();
  });

  it('rejects a media tag with text modality', () => {
    expect(
      TypeTagSchema.safeParse({ kind: 'media', modality: 'text', mimeTypes: ['text/plain'] })
        .success
    ).toBe(false);
  });

  it('rejects a media tag with an empty mime set', () => {
    expect(
      TypeTagSchema.safeParse({ kind: 'media', modality: 'image', mimeTypes: [] }).success
    ).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(TypeTagSchema.safeParse({ kind: 'union', members: [] }).success).toBe(false);
  });

  it('derives media tag modalities from the single modality source', () => {
    expect(MEDIA_TAG_MODALITIES).toEqual(['image', 'audio', 'video', 'embedding']);
  });
});

describe('TYPE_TAG_LAWS', () => {
  it('is the written ten-line laws table', () => {
    expect(TYPE_TAG_LAWS).toHaveLength(10);
    for (const law of TYPE_TAG_LAWS) {
      expect(typeof law).toBe('string');
      expect(law.length).toBeGreaterThan(0);
    }
  });
});

/**
 * `consumer ⊇ producer`, and for the transitivity law a third set above both.
 * Each set is drawn from the one above it rather than independently, because
 * the laws are about nesting and independent draws satisfy them by accident.
 */
const nestedMimes = mimes.chain((consumer) =>
  mimesFrom(consumer).map((producer) => ({ consumer, producer }))
);

const modalities = fc.constantFrom(...MEDIA_TAG_MODALITIES);

describe('isAssignable — property tests against the written laws', () => {
  it('L1 reflexivity: every generated tag is assignable to itself', () => {
    fc.assert(
      fc.property(tagsTo(3), (tag) => {
        expect(isAssignable(tag, tag)).toBe(true);
      })
    );
  });

  it('L2 json exact equality on the schema name', () => {
    expect(isAssignable(jsonTag('a'), jsonTag('a'))).toBe(true);
    expect(isAssignable(jsonTag('a'), jsonTag('b'))).toBe(false);
  });

  it('L3 media modality must match', () => {
    fc.assert(
      fc.property(mimes, modalities, modalities, (mimeTypes, first, second) => {
        const result = isAssignable(mediaTag(first, mimeTypes), mediaTag(second, mimeTypes));
        expect(result).toBe(first === second);
      })
    );
  });

  it('L4 media subset: producer mimes ⊆ consumer mimes', () => {
    fc.assert(
      fc.property(modalities, nestedMimes, (modality, { consumer, producer }) => {
        expect(isAssignable(mediaTag(modality, producer), mediaTag(modality, consumer))).toBe(true);
        const outside = MIME_POOL.find((mime) => !consumer.includes(mime));
        if (outside !== undefined) {
          expect(
            isAssignable(mediaTag(modality, [...producer, outside]), mediaTag(modality, consumer))
          ).toBe(false);
        }
      })
    );
  });

  it('L5 media-subset transitivity: P ⊆ Q ⊆ R composes', () => {
    const chain = mimes.chain((r) =>
      mimesFrom(r).chain((q) => mimesFrom(q).map((p) => ({ r, q, p })))
    );
    fc.assert(
      fc.property(modalities, chain, (modality, { r, q, p }) => {
        expect(isAssignable(mediaTag(modality, p), mediaTag(modality, q))).toBe(true);
        expect(isAssignable(mediaTag(modality, q), mediaTag(modality, r))).toBe(true);
        expect(isAssignable(mediaTag(modality, p), mediaTag(modality, r))).toBe(true);
      })
    );
  });

  it('L6 optional introduction: T → optional<T>', () => {
    fc.assert(
      fc.property(tagsTo(3), (tag) => {
        expect(isAssignable(tag, optionalTag(tag))).toBe(true);
      })
    );
  });

  it('L7 optional covariance: optional<A> → optional<B> iff A → B', () => {
    fc.assert(
      fc.property(tagsTo(2), tagsTo(2), (a, b) => {
        expect(isAssignable(optionalTag(a), optionalTag(b))).toBe(isAssignable(a, b));
      })
    );
  });

  it('L8 optional never erases: optional<T> → T is false', () => {
    fc.assert(
      fc.property(tagsTo(2), (tag) => {
        if (tag.kind !== 'optional') {
          expect(isAssignable(optionalTag(tag), tag)).toBe(false);
        }
      })
    );
  });

  it('L9 list covariance: list<A> → list<B> iff A → B; no wrap/unwrap coercion', () => {
    fc.assert(
      fc.property(tagsTo(2), tagsTo(2), (a, b) => {
        expect(isAssignable(listTag(a), listTag(b))).toBe(isAssignable(a, b));
        expect(isAssignable(listTag(a), a)).toBe(false);
        expect(isAssignable(a, listTag(a))).toBe(false);
      })
    );
  });

  it('L10 kind discrimination: distinct non-optional kinds are never assignable', () => {
    fc.assert(
      fc.property(tagsTo(2), tagsTo(2), (from, to) => {
        if (from.kind !== to.kind && from.kind !== 'optional' && to.kind !== 'optional') {
          expect(isAssignable(from, to)).toBe(false);
        }
      })
    );
  });
});

const registry: SchemaNameRegistry = {
  resolveSchema(name: string): z.ZodType | undefined {
    if (name === 'route') return z.object({ model: z.string() });
    return undefined;
  },
};

describe('zodFor', () => {
  it('text tag validates strings', () => {
    const schema = zodFor(textTag(), registry);
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(42).success).toBe(false);
  });

  it('json tag resolves the registered schema by name', () => {
    const schema = zodFor(jsonTag('route'), registry);
    expect(schema.safeParse({ model: 'gpt' }).success).toBe(true);
    expect(schema.safeParse({ model: 7 }).success).toBe(false);
  });

  it('json tag with an unregistered name fails fast', () => {
    expect(() => zodFor(jsonTag('missing'), registry)).toThrow(/missing/);
  });

  it('media tag validates MediaValue shape including mimeType membership', () => {
    const schema = zodFor(mediaTag('image', ['image/png', 'image/jpeg']), registry);
    const value = {
      ref: 'media/c/m/u',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 10,
      metadata: {},
    };
    expect(schema.safeParse(value).success).toBe(true);
    expect(schema.safeParse({ ...value, mimeType: 'image/webp' }).success).toBe(false);
    expect(schema.safeParse({ ...value, modality: 'video' }).success).toBe(false);
  });

  it('optional tag accepts the absent value', () => {
    const schema = zodFor(optionalTag(textTag()), registry);
    let absent: unknown;
    expect(schema.safeParse(absent).success).toBe(true);
    expect(schema.safeParse('present').success).toBe(true);
    expect(schema.safeParse(3).success).toBe(false);
  });

  it('list tag validates element-wise', () => {
    const schema = zodFor(listTag(textTag()), registry);
    expect(schema.safeParse(['a', 'b']).success).toBe(true);
    expect(schema.safeParse('a').success).toBe(false);
    expect(schema.safeParse([1]).success).toBe(false);
  });
});

describe('deriveNodeSchemas', () => {
  it('derives the input tuple and output schema from declared ports', () => {
    const { input, output } = deriveNodeSchemas(
      { in: [mediaTag('image', ['image/png']), textTag()], out: jsonTag('route') },
      registry
    );
    const media = {
      ref: 'media/c/m/u',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 1,
      metadata: {},
    };
    expect(input.safeParse([media, 'prompt']).success).toBe(true);
    expect(input.safeParse(['prompt']).success).toBe(false);
    expect(output.safeParse({ model: 'gpt' }).success).toBe(true);
  });

  it('derives an empty input tuple for source nodes', () => {
    const { input } = deriveNodeSchemas({ in: [], out: textTag() }, registry);
    expect(input.safeParse([]).success).toBe(true);
    expect(input.safeParse(['extra']).success).toBe(false);
  });

  it('derives runtime schemas for representative ports of every v1 node type', () => {
    // One declared-port shape per node type; runtime schemas come only from
    // zodFor — the mechanism the arch gate later enforces repo-wide.
    const image = mediaTag('image', ['image/png']);
    const portsByNodeType = {
      modelCall: { in: [textTag()], out: textTag() },
      transform: { in: [image], out: mediaTag('image', ['image/png', 'image/webp']) },
      fanOut: { in: [listTag(textTag())], out: textTag() },
      fanIn: { in: [listTag(image), textTag()], out: jsonTag('route') },
      branch: { in: [jsonTag('route')], out: jsonTag('route') },
      loop: { in: [jsonTag('route')], out: jsonTag('route') },
      subWorkflow: { in: [textTag()], out: textTag() },
    } as const;
    for (const ports of Object.values(portsByNodeType)) {
      const { input, output } = deriveNodeSchemas(ports, registry);
      expect(input.safeParse(Array.from({ length: ports.in.length + 1 })).success).toBe(false);
      expect(output).toBeDefined();
    }
    const fanIn = deriveNodeSchemas(portsByNodeType.fanIn, registry);
    const media = {
      ref: 'media/c/m/u',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 1,
      metadata: {},
    };
    expect(fanIn.input.safeParse([[media, media], 'combine these']).success).toBe(true);
    expect(fanIn.output.safeParse({ model: 'gpt' }).success).toBe(true);
  });
});

describe('formatTypeTag', () => {
  it('formats each grammar production canonically', () => {
    expect(formatTypeTag(textTag())).toBe('text');
    expect(formatTypeTag(jsonTag('route'))).toBe('json<route>');
    expect(formatTypeTag(mediaTag('image', ['image/png', 'image/jpeg']))).toBe(
      'media<image:image/png|image/jpeg>'
    );
    expect(formatTypeTag(optionalTag(listTag(textTag())))).toBe('optional<list<text>>');
  });
});

describe('PortId / NodeId / PortRef / Edge', () => {
  it('parses a port reference', () => {
    expect(PortRef.parse({ node: 'n1', port: 'out' })).toEqual({ node: 'n1', port: 'out' });
  });

  it('parses an edge of two port references', () => {
    const edge = { from: { node: 'n1', port: 'out' }, to: { node: 'n2', port: 'in' } };
    expect(Edge.parse(edge)).toEqual(edge);
  });

  it('rejects empty identifiers', () => {
    expect(NodeId.safeParse('').success).toBe(false);
    expect(PortId.safeParse('').success).toBe(false);
  });

  it("rejects a node id containing '#'", () => {
    expect(NodeId.safeParse('body#0').success).toBe(false);
    expect(NodeId.safeParse('#').success).toBe(false);
    expect(NodeId.safeParse('body').success).toBe(true);
  });

  it("reserves 'end' as the early-exit sentinel", () => {
    expect(END_NODE_ID).toBe('end');
    expect(NodeId.parse('end')).toBe(END_NODE_ID);
  });
});
