import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_RECORDING_VERSION, CASSETTE_FILE_SUFFIX } from '@hushbox/shared/cassettes';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-instants';
import { createCassetteStore, type Cassette, type CassetteStore } from './cassette-store.js';
import { recordedMediaCostUsd, recordedStreamCostUsd } from './recorded-cost.js';

/**
 * The absent-cost and unreadable-recording cases, which a run against the real
 * provider cannot produce on demand. The present-cost case is proved where the
 * recording comes from a provider response rather than from this file — in the
 * language and video adapter suites, against the store their own run wrote.
 */

/** These recordings stand in for ones the recording fetch wrote; only the shape matters. */
const RECORDED_AT = isoAt(TEST_DAY_START);

let rootDir: string;
let store: CassetteStore;

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), 'recorded-cost-'));
  store = createCassetteStore({ rootDir });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function cassetteOf(chunks: string[]): Cassette {
  return {
    version: 1,
    exchanges: [
      {
        status: 200,
        statusText: 'OK',
        headers: {},
        chunks: chunks.map((chunk) => Buffer.from(chunk, 'utf8').toString('base64')),
      },
    ],
    recordedAt: RECORDED_AT,
  };
}

function sseChunk(frames: unknown[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
}

/**
 * A store whose scan order is fixed. The real store enumerates its directory,
 * so a case that turns on which recording the scan reaches first cannot be
 * stated against it without depending on filesystem order.
 */
function orderedStore(entries: readonly (readonly [string, Cassette])[]): CassetteStore {
  const byHash = new Map(entries);
  return {
    read: (hash) => byHash.get(hash),
    write: () => {
      throw new Error('orderedStore takes its recordings at construction');
    },
    list: () => entries.map(([hash]) => hash),
  };
}

describe('recordedStreamCostUsd', () => {
  it('yields nothing when no recording carries the generation id', async () => {
    store.write('a', cassetteOf([sseChunk([{ id: 'gen_other', usage: { cost: 0.5 } }])]));

    expect(await recordedStreamCostUsd(store, 'gen_absent')).toBeUndefined();
  });

  it('yields nothing when the recorded stream carried no cost', async () => {
    store.write('a', cassetteOf([sseChunk([{ id: 'gen_free', usage: { total_tokens: 7 } }])]));

    expect(await recordedStreamCostUsd(store, 'gen_free')).toBeUndefined();
  });

  it('yields nothing when the recorded frame is not an object at all', async () => {
    store.write('a', cassetteOf([`data: "gen_scalar"\n\n`]));

    expect(await recordedStreamCostUsd(store, 'gen_scalar')).toBeUndefined();
  });

  it('passes over a recording it cannot read to reach the one it can', async () => {
    store.write('b', cassetteOf([sseChunk([{ id: 'gen_ok', usage: { cost: 0.25 } }])]));
    writeFileSync(
      path.join(rootDir, AI_RECORDING_VERSION, `corrupt${CASSETTE_FILE_SUFFIX}`),
      'not json'
    );

    expect(await recordedStreamCostUsd(store, 'gen_ok')).toBe(0.25);
  });

  /** The scan treats an exchange-less recording as the fetch wrapper does: a miss. */
  it('passes over a recording holding no exchange to reach the one that does', async () => {
    store.write('a', { version: 1, exchanges: [], recordedAt: RECORDED_AT });
    store.write('b', cassetteOf([sseChunk([{ id: 'gen_ok', usage: { cost: 0.25 } }])]));

    expect(await recordedStreamCostUsd(store, 'gen_ok')).toBe(0.25);
  });

  it('reaches the cost when an earlier recording carries the id without one', async () => {
    const ordered = orderedStore([
      ['first', cassetteOf([sseChunk([{ id: 'gen_paid', choices: [] }])])],
      ['second', cassetteOf([sseChunk([{ id: 'gen_paid', usage: { cost: 0.25 } }])])],
    ]);

    expect(await recordedStreamCostUsd(ordered, 'gen_paid')).toBe(0.25);
  });
});

describe('recordedMediaCostUsd', () => {
  it('yields nothing when no recording carries the generation id', async () => {
    store.write('a', cassetteOf([JSON.stringify({ generation_id: 'gen_other' })]));

    expect(await recordedMediaCostUsd(store, 'gen_absent')).toBeUndefined();
  });

  it('yields nothing when the recorded generation carried no cost', async () => {
    store.write('a', cassetteOf([JSON.stringify({ generation_id: 'gen_free', usage: {} })]));

    expect(await recordedMediaCostUsd(store, 'gen_free')).toBeUndefined();
  });

  /**
   * The provider declares `generation_id` on the submit response as well as the
   * poll, so a media flow can record the id twice and only the poll carries the
   * cost.
   */
  it('reaches the cost when an earlier recording carries the id without one', async () => {
    const ordered = orderedStore([
      [
        'submit',
        cassetteOf([JSON.stringify({ id: 'job', generation_id: 'gen_paid', status: 'queued' })]),
      ],
      ['poll', cassetteOf([JSON.stringify({ generation_id: 'gen_paid', usage: { cost: 0.7 } })])],
    ]);

    expect(await recordedMediaCostUsd(ordered, 'gen_paid')).toBe(0.7);
  });
});
