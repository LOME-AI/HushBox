import { describe, expect, it } from 'vitest';
import {
  ModelDescriptor,
  applyMarkupCeil,
  callShapeFamilyFor,
  isRunnableModelShape,
} from '@hushbox/shared';
import { MEDIA_PARAMETER_NAMES } from '@hushbox/shared/affordability';
import { DESCRIPTOR_VERSION } from '@hushbox/api/dev-seed';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { E2E_MODELS } from './model-ids.js';
import { E2E_SEEDED_VIDEO_MODEL_IDS, seededVideoModelUpserts } from './seeded-video-model.js';
import type { UpsertCatalogParams } from '@hushbox/api/dev-seed';

// `seededVideoModelUpserts` builds the synthetic strict-video catalog rows the
// E2E seed injects after `catalog:refresh`. They are the whole of the suite's
// video catalog: no gateway video model is ZDR-reachable, so the refresh
// excludes every one of them and `E2E_MODELS.video` names none. These tests pin
// the descriptors against the SAME shared predicates the send path and the
// catalog exposure gate use, so a synthetic row that would be hidden,
// mis-classified, or unpriceable fails here, not mid-test.

const fetchedAt = new Date(TEST_DAY_START);
const upserts = seededVideoModelUpserts(fetchedAt);

/** A row's per-resolution anchor rates; a row priced any other way fails the test reading it. */
function perSecondRates(params: UpsertCatalogParams): Readonly<Record<string, string>> {
  const { pricing } = params.content;
  if (pricing.kind !== 'perSecond') throw new Error('expected a per-second price');
  return pricing.anchor;
}

describe('seededVideoModelUpserts', () => {
  it('builds one row per seeded video id, in declared order', () => {
    expect(upserts.map((row) => row.modelId)).toEqual([...E2E_SEEDED_VIDEO_MODEL_IDS]);
  });

  it('builds at least two distinct ids, so the video fan-out can select two models', () => {
    expect(upserts.length).toBeGreaterThan(1);
    expect(new Set(upserts.map((row) => row.modelId)).size).toBe(upserts.length);
  });

  it('gives each row its own display name, so the picker renders two separable rows', () => {
    const names = upserts.map((row) => row.content.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names no live partner — the seeded pair is the whole video catalog', () => {
    expect(E2E_MODELS.video).toEqual([]);
    for (const row of upserts) {
      expect(E2E_MODELS.video).not.toContain(row.modelId);
    }
  });
});

describe.each(upserts.map((row): readonly [string, UpsertCatalogParams] => [row.modelId, row]))(
  'seeded video row %s',
  (modelId, params) => {
    it('is keyed by its own id and echoes the fetched-at stamp', () => {
      expect(params.content.id).toBe(modelId);
      expect(params.fetchedAt).toBe(fetchedAt);
    });

    it('is an unranked media row (no popularity rank)', () => {
      expect(params.popularityRank).toBeNull();
    });

    it('builds a descriptor that satisfies the ModelDescriptor contract as-is (the seed parse path)', () => {
      // Exactly what `upsertCatalog` parses: content + fetchedAt, nothing patched.
      // A missing/stale `version` fails here, not mid-`pnpm db:seed`.
      const parsed = ModelDescriptor.safeParse({
        ...params.content,
        fetchedAt: fetchedAt.getTime(),
      });
      expect(parsed.success).toBe(true);
    });

    it('stamps the current descriptor version (v3 = a billable price schedule)', () => {
      expect(params.content.version).toBe(DESCRIPTOR_VERSION);
    });

    it('stores BILLABLE per-second rates — ceil markup over the provider rates', () => {
      // The catalog invariant every row is held to: stored rates are billable
      // (after-fee), never raw provider rates.
      const rates = {
        '720p': applyMarkupCeil(50_000_000n).toString(),
        '1080p': applyMarkupCeil(80_000_000n).toString(),
      };
      expect(params.content.pricing).toEqual({ kind: 'perSecond', anchor: rates, dearest: rates });
    });

    it('prices the higher resolution strictly above the lower one', () => {
      // `video-generation.spec.ts` asserts the cost preview rises when the
      // resolution does; equal rates would let that spec pass on a broken
      // estimator.
      const matrix = perSecondRates(params);
      expect(BigInt(matrix['1080p'] ?? '0')).toBeGreaterThan(BigInt(matrix['720p'] ?? '0'));
    });

    it('keys the price matrix on exactly the resolutions it declares', () => {
      // The estimator resolves a matrix rate by strict exact-key lookup, so a
      // declared resolution with no rate is an unpriceable selection at send time.
      const resolution = params.content.parameters[MEDIA_PARAMETER_NAMES.resolution];
      expect(Object.keys(perSecondRates(params))).toEqual(resolution?.values);
    });

    it('is a runnable, strict-["video"] call shape', () => {
      expect(params.content.outputs).toEqual(['video']);
      expect(callShapeFamilyFor(params.content.outputs)).toBe('video');
      expect(
        isRunnableModelShape({ inputs: params.content.inputs, outputs: params.content.outputs })
      ).toBe(true);
    });

    it('is exposable: ZDR-reachable with a per-second price', () => {
      expect(params.content.zdrReachable).toBe(true);
      expect(params.content.pricing.kind).toBe('perSecond');
    });

    it('declares all three media axes, so no axis is silently unconstrained', () => {
      // A video row with no `aspectRatio` spec is excluded outright by the live
      // normalizer (`missing-aspect-ratio`); the other two axes drive the
      // composer's option lists, and an absent spec reads as unconstrained.
      expect(params.content.parameters[MEDIA_PARAMETER_NAMES.aspectRatio]?.values).toEqual([
        '16:9',
        '9:16',
      ]);
      expect(params.content.parameters[MEDIA_PARAMETER_NAMES.resolution]?.values).toEqual([
        '720p',
        '1080p',
      ]);
      expect(params.content.parameters[MEDIA_PARAMETER_NAMES.durationSeconds]?.values).toEqual([
        4, 6, 8,
      ]);
    });

    it('declares no parameter beyond the three media axes, so no request param is rejected', () => {
      // ParamSpec compiles to a STRICT object: an undeclared request param is a
      // 400, and a declared-but-unsent one the composer never sends is dead
      // weight. The composer sends exactly these three for a video turn.
      expect(new Set(Object.keys(params.content.parameters))).toEqual(
        new Set(Object.values(MEDIA_PARAMETER_NAMES))
      );
    });
  }
);
