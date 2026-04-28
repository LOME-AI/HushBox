import { describe, expect, it } from 'vitest';

import type { StageId } from './events.js';
import { STAGE_LABELS, stageLabel } from './labels.js';

describe('STAGE_LABELS', () => {
  it('has an entry for every StageId', () => {
    const allStageIds: StageId[] = ['smart-model'];
    for (const id of allStageIds) {
      expect(STAGE_LABELS[id]).toBeTruthy();
    }
  });

  it('uses non-empty strings', () => {
    for (const label of Object.values(STAGE_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('stageLabel', () => {
  it('returns the smart-model label', () => {
    expect(stageLabel('smart-model')).toBe(STAGE_LABELS['smart-model']);
  });

  it('returns the human-readable progress text for smart-model', () => {
    expect(stageLabel('smart-model')).toMatch(/best model/i);
  });
});
