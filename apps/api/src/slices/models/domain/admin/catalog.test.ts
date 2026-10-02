import { describe, expect, it } from 'vitest';
import { HOUR_MS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { ADMIN_CATALOG_MODEL_CAP, projectAdminCatalog } from './catalog.js';
import type { StoredDescriptorRow } from '../catalog/store.js';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_MS = TEST_DAY_START;

/** A valid persisted wire-form descriptor (language call shape). */
function descriptorOf(modelId: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    id: modelId,
    provider: 'admin-catalog-test',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: {},
    pricing: { kind: 'tokens', anchor: { base: { input: '2500', output: '2500' }, tiers: [] } },
    zdrReachable: true,
    name: 'Test Model',
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: FIXTURE_STAMP_MS,
    ...overrides,
  };
}

function storedRow(
  modelId: string,
  overrides: Partial<StoredDescriptorRow> = {}
): [string, StoredDescriptorRow] {
  return [
    modelId,
    {
      catalogId: crypto.randomUUID(),
      descriptor: descriptorOf(modelId),
      adminDisabledAt: null,
      excludedReason: null,
      popularityRank: null,
      lastSeenAt: new Date(TEST_DAY_START),
      ...overrides,
    },
  ];
}

describe('projectAdminCatalog', () => {
  it('projects identity and status from a valid descriptor and nothing else', () => {
    const page = projectAdminCatalog(new Map([storedRow('prov/alpha')]));
    expect(page.models).toEqual([
      {
        modelId: 'prov/alpha',
        name: 'Test Model',
        family: 'language',
        zdrReachable: true,
        adminDisabledAt: null,
      },
    ]);
    expect(page.truncated).toBe(false);
  });

  it('includes a disabled model with its adminDisabledAt timestamp', () => {
    const disabledAt = new Date(TEST_DAY_START + 12 * HOUR_MS);
    const page = projectAdminCatalog(
      new Map([storedRow('prov/dead', { adminDisabledAt: disabledAt })])
    );
    expect(page.models[0]?.adminDisabledAt).toEqual(disabledAt);
  });

  it('includes an unexposed (ZDR-unreachable) model with its status', () => {
    const page = projectAdminCatalog(
      new Map([
        storedRow('prov/hidden', {
          descriptor: descriptorOf('prov/hidden', { zdrReachable: false }),
        }),
      ])
    );
    expect(page.models[0]?.zdrReachable).toBe(false);
  });

  it('projects a descriptor without a name as null', () => {
    const descriptor = descriptorOf('prov/nameless') as Record<string, unknown>;
    delete descriptor['name'];
    const page = projectAdminCatalog(new Map([storedRow('prov/nameless', { descriptor })]));
    expect(page.models[0]?.name).toBeNull();
  });

  it('keeps a row whose stored descriptor fails the contract, with null projections', () => {
    const disabledAt = new Date(TEST_DAY_START + 12 * HOUR_MS);
    const page = projectAdminCatalog(
      new Map([
        storedRow('prov/corrupt', { descriptor: { junk: true }, adminDisabledAt: disabledAt }),
      ])
    );
    expect(page.models).toEqual([
      {
        modelId: 'prov/corrupt',
        name: null,
        family: null,
        zdrReachable: null,
        adminDisabledAt: disabledAt,
      },
    ]);
  });

  it('nulls the family when a valid descriptor has no dispatchable output', () => {
    // outputs: ['audio'] parses (a valid Modality) but classifies to no
    // call-shape family, so dispatchFamilyFor returns undefined → null.
    const page = projectAdminCatalog(
      new Map([
        storedRow('prov/audio', { descriptor: descriptorOf('prov/audio', { outputs: ['audio'] }) }),
      ])
    );
    expect(page.models[0]).toEqual({
      modelId: 'prov/audio',
      name: 'Test Model',
      family: null,
      zdrReachable: true,
      adminDisabledAt: null,
    });
  });

  it('orders deterministically by model id', () => {
    const page = projectAdminCatalog(
      new Map([storedRow('prov/zeta'), storedRow('prov/alpha'), storedRow('prov/mid')])
    );
    expect(page.models.map((model) => model.modelId)).toEqual([
      'prov/alpha',
      'prov/mid',
      'prov/zeta',
    ]);
  });

  it('caps the page at ADMIN_CATALOG_MODEL_CAP and flags truncation', () => {
    const rows = new Map(
      Array.from({ length: ADMIN_CATALOG_MODEL_CAP + 1 }, (_, index) =>
        storedRow(`prov/model-${String(index).padStart(5, '0')}`)
      )
    );
    const page = projectAdminCatalog(rows);
    expect(page.models).toHaveLength(ADMIN_CATALOG_MODEL_CAP);
    expect(page.truncated).toBe(true);
  });
});
