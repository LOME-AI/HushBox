import { describe, expect, it } from 'vitest';
import {
  ModelDescriptor,
  PRICING_KIND_BY_FAMILY,
  callShapeFamilyFor,
  isExposedModel,
  isRunnableModelShape,
} from './model-descriptor.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import { TEST_DAY_START, secondsAt } from '../../testing/test-time.ts';
import type { CallShapeFamily } from './model-descriptor.ts';
import type { Modality } from './modality.ts';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

/** The same instant in the milliseconds `fetchedAt` carries, and equally inert. */
const FIXTURE_STAMP_MS = TEST_DAY_START;

const validDescriptor = {
  id: 'openai/gpt-5',
  provider: 'openai',
  version: '2026-06-01',
  inputs: ['text', 'image'],
  outputs: ['text'],
  parameters: {
    temperature: { type: 'number', min: 0, max: 2 },
  },
  behaviors: ['streaming', 'tools'],
  limits: { contextTokens: 400_000 },
  pricing: { kind: 'tokens', anchor: { base: { input: '500', output: '1500' }, tiers: [] } },
  zdrReachable: true,
  releasedAt: FIXTURE_STAMP_SECONDS,
  fetchedAt: FIXTURE_STAMP_MS,
};

describe('ModelDescriptor pricing', () => {
  it('parses a token schedule’s nano-USD string rates into bigints', () => {
    expect(ModelDescriptor.parse(validDescriptor).pricing).toEqual(
      tokenPricingFixture({ input: 500n, output: 1500n })
    );
  });

  it('refuses the flat rate bag an earlier descriptor version stored', () => {
    const flat = { ...validDescriptor, pricing: { inputPerToken: '500', outputPerToken: '1500' } };
    expect(ModelDescriptor.safeParse(flat).success).toBe(false);
  });

  it('refuses a JSON number where a rate string belongs (a float would truncate)', () => {
    const numeric = {
      ...validDescriptor,
      pricing: { kind: 'perImage', anchor: 500, dearest: 500 },
    };
    expect(ModelDescriptor.safeParse(numeric).success).toBe(false);
  });
});

describe('callShapeFamilyFor', () => {
  const table: readonly [readonly Modality[], CallShapeFamily | undefined][] = [
    [['text'], 'language'],
    [['text', 'image'], 'language'],
    [['text', 'video'], 'language'],
    [['text', 'image', 'video'], 'language'],
    [['embedding'], 'embedding'],
    [['embedding', 'image'], 'embedding'],
    [['embedding', 'video'], 'embedding'],
    [['image'], 'image'],
    [['image', 'video'], 'image'],
    [['video'], 'video'],
    [['video', 'audio'], 'video'],
    [['audio'], undefined],
    [[], undefined],
  ];

  it.each(table)('classifies outputs %j as %s', (outputs, family) => {
    expect(callShapeFamilyFor(outputs)).toBe(family);
  });

  it('media-classifies an image+video descriptor so the media ZDR exposure gate applies', () => {
    // The dangerous shape: no text output, two media outputs. Classifying it
    // language would skip the dated-ZDR media gate while the adapter routes
    // it to the image call-shape — the divergence this function exists to
    // make impossible.
    expect(callShapeFamilyFor(['image', 'video'])).toBe('image');
  });

  it('classifies text+embedding as language (text wins over embedding)', () => {
    expect(callShapeFamilyFor(['text', 'embedding'])).toBe('language');
  });

  it('returns undefined for audio-only outputs (no call-shape exists yet)', () => {
    expect(callShapeFamilyFor(['audio'])).toBeUndefined();
  });
});

describe('isRunnableModelShape', () => {
  const shape = (inputs: Modality[], outputs: Modality[]): ModelDescriptor =>
    ModelDescriptor.parse({ ...validDescriptor, inputs, outputs });

  it('accepts text-in text-out', () => {
    expect(isRunnableModelShape(shape(['text'], ['text']))).toBe(true);
  });

  it('accepts multimodal input (text plus image) with a single text output', () => {
    expect(isRunnableModelShape(shape(['text', 'image'], ['text']))).toBe(true);
  });

  it('accepts text-in single image output', () => {
    expect(isRunnableModelShape(shape(['text'], ['image']))).toBe(true);
  });

  it('accepts multimodal input with a single video output', () => {
    expect(isRunnableModelShape(shape(['text', 'image'], ['video']))).toBe(true);
  });

  it('rejects multi-output (image plus text)', () => {
    expect(isRunnableModelShape(shape(['text'], ['image', 'text']))).toBe(false);
  });

  it('rejects a model that does not accept text input', () => {
    expect(isRunnableModelShape(shape(['image'], ['image']))).toBe(false);
  });

  it('rejects audio output (no routable call-shape family)', () => {
    expect(isRunnableModelShape(shape(['text'], ['audio']))).toBe(false);
  });

  it('rejects embedding output', () => {
    expect(isRunnableModelShape(shape(['text'], ['embedding']))).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(isRunnableModelShape(shape([], ['text']))).toBe(false);
  });

  it('rejects empty outputs', () => {
    expect(isRunnableModelShape(shape(['text'], []))).toBe(false);
  });
});

describe('ModelDescriptor', () => {
  it('parses the descriptor shape', () => {
    const parsed = ModelDescriptor.parse(validDescriptor);
    expect(parsed.id).toBe('openai/gpt-5');
    expect(parsed.pricing).toEqual(tokenPricingFixture({ input: 500n, output: 1500n }));
    expect(parsed.zdrReachable).toBe(true);
  });

  it('parses releasedAt as a unix-seconds release timestamp', () => {
    expect(ModelDescriptor.parse(validDescriptor).releasedAt).toBe(FIXTURE_STAMP_SECONDS);
  });

  it('parses an optional description (the classifier prompt line)', () => {
    const parsed = ModelDescriptor.parse({ ...validDescriptor, description: 'Fast and cheap.' });
    expect(parsed.description).toBe('Fast and cheap.');
  });

  it('leaves description absent when the source metadata carries none (never excludes)', () => {
    const parsed = ModelDescriptor.parse(validDescriptor);
    expect(parsed.description).toBeUndefined();
  });

  it('requires releasedAt (fail-closed: a model with no known release date is not exposed)', () => {
    const rest: Record<string, unknown> = { ...validDescriptor };
    delete rest['releasedAt'];
    expect(ModelDescriptor.safeParse(rest).success).toBe(false);
  });

  it('rejects an unknown modality in inputs', () => {
    expect(ModelDescriptor.safeParse({ ...validDescriptor, inputs: ['speech'] }).success).toBe(
      false
    );
  });

  it('rejects an invalid nested ParamSpec', () => {
    expect(
      ModelDescriptor.safeParse({
        ...validDescriptor,
        parameters: { temperature: { type: 'object' } },
      }).success
    ).toBe(false);
  });

  it('requires zdrReachable (fail-closed ZDR is a required fact, not a default)', () => {
    // eslint-disable-next-line sonarjs/no-unused-vars -- rest-spread requires naming the omitted key
    const { zdrReachable: _zdr, ...rest } = validDescriptor;
    expect(ModelDescriptor.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-numeric limits value', () => {
    expect(
      ModelDescriptor.safeParse({ ...validDescriptor, limits: { contextTokens: 'big' } }).success
    ).toBe(false);
  });

  it('accepts and preserves a zero popularityRank (most-used is rank 0)', () => {
    const parsed = ModelDescriptor.parse({ ...validDescriptor, popularityRank: 0 });
    expect(parsed.popularityRank).toBe(0);
  });

  it('accepts and preserves a positive popularityRank', () => {
    const parsed = ModelDescriptor.parse({ ...validDescriptor, popularityRank: 42 });
    expect(parsed.popularityRank).toBe(42);
  });

  it('leaves popularityRank undefined when absent (never materialized)', () => {
    expect(ModelDescriptor.parse(validDescriptor).popularityRank).toBeUndefined();
  });

  it('rejects a negative popularityRank', () => {
    expect(ModelDescriptor.safeParse({ ...validDescriptor, popularityRank: -1 }).success).toBe(
      false
    );
  });

  it('rejects a non-integer popularityRank', () => {
    expect(ModelDescriptor.safeParse({ ...validDescriptor, popularityRank: 1.5 }).success).toBe(
      false
    );
  });

  it('parses the optional structured reasoning field', () => {
    const parsed = ModelDescriptor.parse({
      ...validDescriptor,
      reasoning: {
        mandatory: true,
        supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'none'],
        defaultEffort: 'medium',
        defaultEnabled: true,
      },
    });
    expect(parsed.reasoning).toEqual({
      mandatory: true,
      supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'none'],
      defaultEffort: 'medium',
      defaultEnabled: true,
    });
  });

  it('preserves unknown effort strings raw (no enum narrowing at parse)', () => {
    const parsed = ModelDescriptor.parse({
      ...validDescriptor,
      reasoning: { supportedEfforts: ['ultra-think', 'max'] },
    });
    expect(parsed.reasoning?.supportedEfforts).toEqual(['ultra-think', 'max']);
  });

  it('preserves a null supportedEfforts (upstream: every effort accepted) distinct from absent', () => {
    const parsed = ModelDescriptor.parse({
      ...validDescriptor,
      reasoning: { mandatory: false, supportedEfforts: null },
    });
    expect(parsed.reasoning?.supportedEfforts).toBeNull();
  });

  it('parses a reasoning object with every sub-field absent (presence alone is signal)', () => {
    const parsed = ModelDescriptor.parse({ ...validDescriptor, reasoning: {} });
    expect(parsed.reasoning).toEqual({});
  });

  it('leaves reasoning absent when the source carries none (backward-compatible rows)', () => {
    const parsed = ModelDescriptor.parse(validDescriptor);
    expect(parsed.reasoning).toBeUndefined();
  });

  it('rejects non-string entries in supportedEfforts', () => {
    expect(
      ModelDescriptor.safeParse({ ...validDescriptor, reasoning: { supportedEfforts: [2] } })
        .success
    ).toBe(false);
  });
});

describe('isExposedModel', () => {
  const exposed = ModelDescriptor.parse(validDescriptor);

  it('exposes a ZDR-reachable, priced, single-text-output model', () => {
    expect(isExposedModel(exposed)).toBe(true);
  });

  it('hides a ZDR-unreachable model', () => {
    expect(isExposedModel({ ...exposed, zdrReachable: false })).toBe(false);
  });

  it('never meets a model priced at nothing: no price kind parses without a rate', () => {
    const pricedAtNothing = [
      { kind: 'tokens', anchor: { base: { input: '0', output: '0' }, tiers: [] } },
      { kind: 'perImage', anchor: '0', dearest: '0' },
      { kind: 'perSecond', anchor: {}, dearest: {} },
    ];
    for (const pricing of pricedAtNothing) {
      expect(ModelDescriptor.safeParse({ ...validDescriptor, pricing }).success).toBe(false);
    }
  });

  it('hides an embedding model, for which no adapter ships', () => {
    expect(isExposedModel({ ...exposed, inputs: ['text'], outputs: ['embedding'] })).toBe(false);
  });

  it('hides a dual text/image output model no turn can run', () => {
    expect(isExposedModel({ ...exposed, outputs: ['text', 'image'] })).toBe(false);
  });

  it('hides a model that does not accept text input', () => {
    expect(isExposedModel({ ...exposed, inputs: ['image'] })).toBe(false);
  });
});

describe('PRICING_KIND_BY_FAMILY', () => {
  it('charges language and embedding by tokens, image per image and video per second', () => {
    expect(PRICING_KIND_BY_FAMILY).toEqual({
      language: 'tokens',
      image: 'perImage',
      video: 'perSecond',
      embedding: 'tokens',
    });
  });
});
