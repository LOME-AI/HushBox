/**
 * Which rungs a row publishes its own ceiling for. The server caps a Smart-slot
 * candidate per rung only on an `auto` send that searches beside a pinned
 * sibling and whose menu leaves two or more rungs to decide between, and only
 * at the rungs that menu marks available; at every other turn it caps at the
 * graded ceiling. A ceiling published for a rung the server never applies would
 * let a surface warn about a cut no reply can meet, so each clause of that rule
 * is pinned here on its own.
 */

import { describe, expect, it } from 'vitest';

import { modelId } from '../model/model-id.ts';
import { poolModelFromWire } from '../model/wire-pool-row.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { PREMIUM_RECENCY_MS } from '../money/premium.ts';
import { getTurnOptions } from './turn-options.ts';
import type { OptionSet, Selection } from './turn-types.ts';
import type { Model } from '../../schemas/api/models.ts';

/** A served three-rung reasoning row at 10,000 / 30,000 nano per token. */
function reasoningRow(id: string, maxOutputTokens: number): Model {
  return {
    id,
    name: id,
    provider: 'vendor',
    modality: 'text',
    contextLength: 128_000,
    maxOutputTokens,
    pricing: { anchorContextTokens: 1_000_000, inputPerToken: '10000', outputPerToken: '30000' },
    description: 'a reasoning model',
    supportedParameters: [],
    created: 0,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  };
}

const CATALOG = [
  reasoningRow('v/m1', 8000),
  reasoningRow('v/m2', 7583),
  reasoningRow('v/m3', 7583),
  reasoningRow('v/m4', 7583),
];

/** A balance at which the menu marks `off` and `low` available. */
const TWO_RUNGS = 5_000_000_000n;

/** A balance at which the menu marks `off` alone available. */
const ONE_RUNG = 3_000_000_000n;

/** An `auto` send of the Smart slot beside the pinned `v/m1`, searching. */
const AUTO_SEARCHING: Selection = {
  answerSources: { models: [modelId('v/m1')], smartSlot: true },
  modality: 'text',
  pinned: {},
  webSearch: true,
  effortAuto: true,
};

function admissibleAt(selection: Selection, spendable: bigint = TWO_RUNGS): OptionSet {
  return getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(spendable),
      heldNanoUsd: nanoUSD(0n),
      payerTier: 'paid',
      payer: 'self',
    },
    { systemChars: 0, instructionChars: 0, historyChars: 0, inputChars: 4000, attachmentBytes: 0 },
    selection,
    { models: CATALOG.flatMap((row) => poolModelFromWire(row) ?? []), nowMs: PREMIUM_RECENCY_MS }
  ).admissible;
}

function availableRungs(set: OptionSet): readonly string[] {
  return set.turnDimensions.flatMap((dimension) =>
    dimension.options.flatMap((option) => (option.availability.available ? [option.optionId] : []))
  );
}

/** Every row's published rungs, by model id. */
function publishedRungs(set: OptionSet): ReadonlyMap<string, readonly string[]> {
  return new Map(set.all.map((entry) => [entry.modelId, entry.rungCeilings.map((r) => r.effort)]));
}

describe('the rungs a row publishes its own ceiling for', () => {
  it('lists the menu’s available rungs on an auto searching send beside a pinned sibling', () => {
    const set = admissibleAt(AUTO_SEARCHING);

    expect(availableRungs(set)).toEqual(['off', 'low']);
    for (const rungs of publishedRungs(set).values()) expect(rungs).toEqual(['off', 'low']);
  });

  it('lists no rung the menu does not mark available', () => {
    const set = admissibleAt(AUTO_SEARCHING);
    const offered = set.turnDimensions.flatMap((dimension) =>
      dimension.options.map((option) => option.optionId)
    );
    const available = new Set(availableRungs(set));

    expect(offered.some((optionId) => !available.has(optionId))).toBe(true);
    for (const rungs of publishedRungs(set).values()) {
      expect(rungs.filter((rung) => !available.has(rung))).toEqual([]);
    }
  });

  it('lists none when the send pins its rung', () => {
    const set = admissibleAt({ ...AUTO_SEARCHING, pinned: { effort: 'low' }, effortAuto: false });

    for (const rungs of publishedRungs(set).values()) expect(rungs).toEqual([]);
  });

  it('lists none on an open axis the send did not leave to auto', () => {
    const set = admissibleAt({ ...AUTO_SEARCHING, effortAuto: false });

    expect(availableRungs(set)).toEqual(['off', 'low']);
    for (const rungs of publishedRungs(set).values()) expect(rungs).toEqual([]);
  });

  it('lists none when the turn does not search', () => {
    const set = admissibleAt({ ...AUTO_SEARCHING, webSearch: false });

    expect(availableRungs(set).length).toBeGreaterThanOrEqual(2);
    for (const rungs of publishedRungs(set).values()) expect(rungs).toEqual([]);
  });

  it('lists none when no sibling is pinned beside the slot', () => {
    const set = admissibleAt({
      ...AUTO_SEARCHING,
      answerSources: { models: [], smartSlot: true },
    });

    expect(availableRungs(set).length).toBeGreaterThanOrEqual(2);
    for (const rungs of publishedRungs(set).values()) expect(rungs).toEqual([]);
  });

  it('lists none when the menu leaves a single rung to run', () => {
    const set = admissibleAt(AUTO_SEARCHING, ONE_RUNG);

    expect(availableRungs(set)).toEqual(['off']);
    for (const rungs of publishedRungs(set).values()) expect(rungs).toEqual([]);
  });
});
