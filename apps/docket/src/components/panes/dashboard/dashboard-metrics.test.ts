import { describe, it, expect } from 'vitest';
import { makeFinding, makeQuestion } from '@/test-utils/finding-fixture';
import { sectionSpec } from '@/components/shell/logic/sections';
import { dashboardMetrics } from './dashboard-metrics';
import type { FindingJson } from '@hushbox/docket';

function ruledByAudit(id: string, overrides: Partial<FindingJson> = {}): FindingJson {
  return makeFinding({
    id,
    state: 'ruled',
    needsRuling: false,
    ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
    ...overrides,
  });
}

function ruledByHuman(id: string, overrides: Partial<FindingJson> = {}): FindingJson {
  return makeFinding({
    id,
    state: 'ruled',
    needsRuling: true,
    ruling: { option: 'A', text: null, note: null, at: '2026-07-31' },
    ...overrides,
  });
}

function deniedBy(id: string, by: 'human' | 'audit'): FindingJson {
  return makeFinding({
    id,
    state: 'denied',
    denial: { by, reason: null, at: '2026-07-30' },
  });
}

describe('dashboardMetrics', () => {
  it('counts the findings still waiting on a human', () => {
    const metrics = dashboardMetrics([
      makeFinding({ id: 'A-1', state: 'open' }),
      makeFinding({ id: 'A-2', state: 'open', questions: [makeQuestion()] }),
      ruledByAudit('A-3'),
    ]);

    expect(metrics.awaiting).toBe(2);
  });

  it('counts the findings the audit settled without asking a human', () => {
    const metrics = dashboardMetrics([ruledByAudit('A-1'), deniedBy('A-2', 'audit')]);

    expect(metrics.settledByAudit).toBe(2);
  });

  it('counts the findings a human decided', () => {
    const metrics = dashboardMetrics([ruledByHuman('A-1'), deniedBy('A-2', 'human')]);

    expect(metrics.decidedByHuman).toBe(2);
  });

  it('credits the reader with a finding they reopened and ruled again', () => {
    const reruled = makeFinding({
      id: 'A-1',
      state: 'ruled',
      needsRuling: false,
      ruling: { option: 'B', text: null, note: null, at: '2026-07-31' },
      history: [
        {
          at: '2026-07-30',
          kind: 'ruling',
          superseded_at: '2026-07-31',
          option: 'A',
          text: null,
          note: null,
        },
      ],
    });

    const metrics = dashboardMetrics([reruled]);

    expect(metrics.decidedByHuman).toBe(1);
    expect(metrics.settledByAudit).toBe(0);
  });

  it('puts every finding in exactly one of the three buckets', () => {
    const findings = [
      makeFinding({ id: 'A-1', state: 'open' }),
      makeFinding({ id: 'A-2', state: 'open', questions: [makeQuestion()] }),
      ruledByAudit('A-3'),
      deniedBy('A-4', 'audit'),
      ruledByHuman('A-5'),
      deniedBy('A-6', 'human'),
    ];

    const metrics = dashboardMetrics(findings);

    expect(metrics.awaiting + metrics.settledByAudit + metrics.decidedByHuman).toBe(metrics.total);
  });

  it('reports every severity in remaining work, including the ones at zero', () => {
    const metrics = dashboardMetrics([makeFinding({ id: 'A-1', severity: 'high' })]);

    expect(metrics.bySeverity).toEqual([
      { severity: 'critical', count: 0 },
      { severity: 'high', count: 1 },
      { severity: 'medium', count: 0 },
      { severity: 'low', count: 0 },
    ]);
  });

  it('leaves decided findings out of the severity breakdown', () => {
    const metrics = dashboardMetrics([
      makeFinding({ id: 'A-1', severity: 'critical' }),
      ruledByAudit('A-2', { severity: 'critical' }),
    ]);

    expect(metrics.bySeverity[0]).toEqual({ severity: 'critical', count: 1 });
  });

  it('breaks remaining work down by area, busiest first', () => {
    const metrics = dashboardMetrics([
      makeFinding({ id: 'A-1', area: 'apps/web' }),
      makeFinding({ id: 'A-2', area: 'unknown' }),
      makeFinding({ id: 'A-3', area: 'unknown' }),
      ruledByAudit('A-4', { area: 'apps/api' }),
    ]);

    expect(metrics.byArea).toEqual([
      { value: 'unknown', count: 2 },
      { value: 'apps/web', count: 1 },
    ]);
  });

  it('counts ruled findings that implementation is blocked on', () => {
    const metrics = dashboardMetrics([
      ruledByAudit('A-1', {
        progress: { status: 'blocked', updated: null, verified: false, notes: [] },
      }),
      ruledByAudit('A-2'),
    ]);

    expect(metrics.blocked).toBe(1);
  });

  /**
   * The figure is a way into the queue, so it has to count what that queue
   * holds. Asserted against the section's own predicate rather than a number,
   * because a number agrees today and says nothing about the two definitions
   * moving apart.
   */
  it('counts exactly what the queue it opens holds', () => {
    const findings = [
      ruledByAudit('A-1', {
        progress: { status: 'blocked', updated: null, verified: false, notes: [] },
      }),
      ruledByAudit('A-2'),
      makeFinding({
        id: 'A-3',
        state: 'open',
        progress: { status: 'blocked', updated: null, verified: false, notes: [] },
      }),
    ];

    expect(dashboardMetrics(findings).blocked).toBe(
      findings.filter((finding) => sectionSpec('blocked').holds(finding)).length
    );
  });

  it('counts findings marked as needing a session of their own', () => {
    const metrics = dashboardMetrics([
      makeFinding({ id: 'A-1', dedicated: true }),
      ruledByAudit('A-2', { dedicated: true }),
      ruledByAudit('A-3'),
    ]);

    expect(metrics.dedicated).toBe(2);
  });

  it('counts exactly what the dedicated queue holds', () => {
    const findings = [
      makeFinding({ id: 'A-1', dedicated: true }),
      ruledByAudit('A-2'),
      deniedBy('A-3', 'human'),
    ];

    expect(dashboardMetrics(findings).dedicated).toBe(
      findings.filter((finding) => sectionSpec('dedicated').holds(finding)).length
    );
  });

  it('counts every finding in scope as the total', () => {
    const metrics = dashboardMetrics([
      makeFinding({ id: 'A-1' }),
      ruledByAudit('A-2'),
      deniedBy('A-3', 'human'),
    ]);

    expect(metrics.total).toBe(3);
  });
});
