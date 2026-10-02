import { describe, expect, it } from 'vitest';
import { EXCLUDE_REASONS } from '@hushbox/shared';
import { alertMassExclusion } from './refresh.js';
import type { ExcludeReason } from '@hushbox/shared';
import type { SafeLogFields, Telemetry } from '../../../../lib/telemetry/index.js';
import type { RefreshSummary } from './refresh.js';

interface RecordedLine {
  readonly msg: string;
  readonly fields: SafeLogFields | undefined;
}

interface RecordedCapture {
  readonly message: string;
  readonly code: string;
}

function recordingTelemetry(warns: RecordedLine[], captures: RecordedCapture[]): Telemetry {
  return {
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: SafeLogFields) => {
      warns.push({ msg, fields });
    },
    error: () => {},
    captureError: (error: Error, code: string) => {
      captures.push({ message: error.message, code });
    },
  };
}

function excludedByReason(
  overrides: Partial<Record<ExcludeReason, number>>
): Record<ExcludeReason, number> {
  const counts = {} as Record<ExcludeReason, number>;
  for (const reason of EXCLUDE_REASONS) counts[reason] = overrides[reason] ?? 0;
  return counts;
}

function summaryOf(overrides: Partial<RefreshSummary> = {}): RefreshSummary {
  return {
    discovered: 100,
    written: 0,
    unchanged: 0,
    excluded: 0,
    excludedByReason: excludedByReason({}),
    excludedReasonById: new Map(),
    previouslyIncluded: 0,
    newlyExcluded: 0,
    ...overrides,
  };
}

function warnsFor(summary: RefreshSummary): RecordedLine[] {
  const warns: RecordedLine[] = [];
  alertMassExclusion(recordingTelemetry(warns, []), summary);
  return warns;
}

function capturesFor(summary: RefreshSummary): RecordedCapture[] {
  const captures: RecordedCapture[] = [];
  alertMassExclusion(recordingTelemetry([], captures), summary);
  return captures;
}

describe('alertMassExclusion', () => {
  it('warns when a refresh newly excludes half of the previously included catalog', () => {
    expect(warnsFor(summaryOf({ previouslyIncluded: 80, newlyExcluded: 40 }))).toEqual([
      {
        msg: 'catalog refresh newly excluded most of the models it was selling',
        fields: { droppedCount: 40, errorCode: 'model_catalog_mass_exclusion' },
      },
    ]);
  });

  it('stays silent when a refresh newly excludes less than half of it', () => {
    expect(warnsFor(summaryOf({ previouslyIncluded: 80, newlyExcluded: 39 }))).toEqual([]);
  });

  it('stays silent when the catalog held nothing before the refresh', () => {
    expect(warnsFor(summaryOf({ previouslyIncluded: 0, newlyExcluded: 0 }))).toEqual([]);
  });

  it('reports the empty retention list rather than the share when both hold', () => {
    const summary = summaryOf({
      discovered: 100,
      excluded: 100,
      excludedByReason: excludedByReason({ 'non-zdr': 100 }),
      previouslyIncluded: 80,
      newlyExcluded: 80,
    });
    expect(warnsFor(summary)).toEqual([
      {
        msg: 'gateway retention list excluded every discovered model — nothing is sellable',
        fields: { droppedCount: 80, errorCode: 'model_catalog_retention_list_empty' },
      },
    ]);
  });

  it('stays silent when the gateway discovered nothing at all', () => {
    expect(warnsFor(summaryOf({ discovered: 0 }))).toEqual([]);
  });

  it('pages Sentry once with a content-free message when nothing is left to sell', () => {
    const summary = summaryOf({
      discovered: 100,
      excluded: 100,
      excludedByReason: excludedByReason({ 'non-zdr': 100 }),
      previouslyIncluded: 80,
      newlyExcluded: 80,
    });
    expect(capturesFor(summary)).toEqual([
      {
        message: 'gateway retention list excluded every discovered model',
        code: 'model_catalog_retention_list_empty',
      },
    ]);
  });

  it('pages Sentry once with a content-free message on a mass exclusion', () => {
    expect(capturesFor(summaryOf({ previouslyIncluded: 80, newlyExcluded: 40 }))).toEqual([
      {
        message: 'catalog refresh newly excluded most of the models it was selling',
        code: 'model_catalog_mass_exclusion',
      },
    ]);
  });

  it('pages nobody when neither aggregate condition holds', () => {
    expect(capturesFor(summaryOf({ previouslyIncluded: 80, newlyExcluded: 39 }))).toEqual([]);
  });
});
