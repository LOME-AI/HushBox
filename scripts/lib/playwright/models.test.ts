import { describe, it, expect } from 'vitest';
import { E2E_MODELS, e2eModelIds } from './models.js';
import { HOLD_PROBE_MODEL_ID, PRESENCE_ONLY_MODELS } from './model-ids.js';

const MODALITIES = ['text', 'image', 'video'] as const;

// A well-formed OpenRouter id is `provider/model` — lowercase provider slug, a
// single slash, a non-empty model segment.
const WELL_FORMED_ID = /^[a-z0-9-]+\/[a-zA-Z0-9._-]+$/;

describe('E2E_MODELS', () => {
  it('declares a live id for every modality the gateway sells a ZDR model in', () => {
    expect(E2E_MODELS.text.length).toBeGreaterThan(0);
    expect(E2E_MODELS.image.length).toBeGreaterThan(0);
  });

  it('declares no live video id — no gateway video model is ZDR-reachable', () => {
    expect(E2E_MODELS.video).toEqual([]);
  });

  it('has well-formed provider/model ids in every modality', () => {
    for (const modality of MODALITIES) {
      for (const id of E2E_MODELS[modality]) {
        expect(id).toMatch(WELL_FORMED_ID);
      }
    }
  });

  it('exposes no duplicate ids across modalities', () => {
    const ids = e2eModelIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('flattens every modality into e2eModelIds', () => {
    expect(e2eModelIds()).toEqual([...E2E_MODELS.text, ...E2E_MODELS.image, ...E2E_MODELS.video]);
  });
});

describe('PRESENCE_ONLY_MODELS', () => {
  it('has well-formed provider/model ids', () => {
    for (const id of Object.values(PRESENCE_ONLY_MODELS)) {
      expect(id).toMatch(WELL_FORMED_ID);
    }
  });

  it('names distinct ids, so the two nametags a routed turn compares differ', () => {
    const ids = Object.values(PRESENCE_ONLY_MODELS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shares no id with E2E_MODELS, which guarantees more about its text ids than this set does', () => {
    for (const id of Object.values(PRESENCE_ONLY_MODELS)) {
      expect(e2eModelIds()).not.toContain(id);
    }
  });
});

describe('HOLD_PROBE_MODEL_ID', () => {
  it('has a well-formed provider/model id', () => {
    expect(HOLD_PROBE_MODEL_ID).toMatch(WELL_FORMED_ID);
  });

  it('shares no id with E2E_MODELS, whose text ids must stay selectable at a zero balance', () => {
    expect(e2eModelIds()).not.toContain(HOLD_PROBE_MODEL_ID);
  });

  it('shares no id with PRESENCE_ONLY_MODELS, which promises nothing about a hold size', () => {
    expect(Object.values(PRESENCE_ONLY_MODELS)).not.toContain(HOLD_PROBE_MODEL_ID);
  });
});
