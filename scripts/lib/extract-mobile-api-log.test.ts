import { describe, it, expect } from 'vitest';
import { extractRelevantSlice, MARKER_PREFIX } from './extract-mobile-api-log.js';

const RUN_ID = 'abc12345';
const OTHER_RUN_ID = 'def67890';
const MOBILE_VERSION = 'local-mobile-test';

function startMarker(runId: string, iso = '2026-05-26T03:18:00.000Z'): string {
  return `${MARKER_PREFIX} ${runId} START ${iso} =====`;
}

function endMarker(runId: string, iso = '2026-05-26T03:21:43.000Z'): string {
  return `${MARKER_PREFIX} ${runId} END ${iso} =====`;
}

function reqLine(version: string, path = '/api/auth/login/init', status = 200): string {
  return `[req] 2026-05-26T03:18:42.119Z POST ${path} ${String(status)} 117ms v=${version}`;
}

describe('extractRelevantSlice', () => {
  it('returns empty string when no START marker for runId is present', () => {
    const raw = [reqLine(MOBILE_VERSION), '[wrangler:info] Ready'].join('\n');
    expect(
      extractRelevantSlice({ rawLog: raw, runId: RUN_ID, mobileVersion: MOBILE_VERSION })
    ).toBe('');
  });

  it('slices from START to END for the matching runId', () => {
    const raw = [
      '[wrangler:info] Ready',
      reqLine(MOBILE_VERSION, '/before'),
      startMarker(RUN_ID),
      reqLine(MOBILE_VERSION, '/during'),
      endMarker(RUN_ID),
      reqLine(MOBILE_VERSION, '/after'),
    ].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
      mobileVersion: MOBILE_VERSION,
    });

    expect(slice).toContain('/during');
    expect(slice).not.toContain('/before');
    expect(slice).not.toContain('/after');
    expect(slice).toContain(startMarker(RUN_ID));
    expect(slice).toContain(endMarker(RUN_ID));
  });

  it('slices from START to EOF when END marker is missing (crash mid-run)', () => {
    const raw = [
      startMarker(RUN_ID),
      reqLine(MOBILE_VERSION, '/during'),
      '[wrangler:error] something blew up',
    ].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
      mobileVersion: MOBILE_VERSION,
    });

    expect(slice).toContain('/during');
    expect(slice).toContain('[wrangler:error]');
  });

  it('filters [req] lines to those matching mobileVersion', () => {
    const raw = [
      startMarker(RUN_ID),
      reqLine(MOBILE_VERSION, '/mine'),
      reqLine('dev-local', '/theirs'),
      endMarker(RUN_ID),
    ].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
      mobileVersion: MOBILE_VERSION,
    });

    expect(slice).toContain('/mine');
    expect(slice).not.toContain('/theirs');
  });

  it('preserves non-[req] lines regardless of source (banners, errors, stack traces)', () => {
    const raw = [
      startMarker(RUN_ID),
      '[wrangler:info] Ready on http://localhost:8915',
      '[wrangler:error] TypeError: cannot read property of undefined',
      '    at someFunction (file.ts:42:10)',
      reqLine(MOBILE_VERSION, '/mine'),
      endMarker(RUN_ID),
    ].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
      mobileVersion: MOBILE_VERSION,
    });

    expect(slice).toContain('[wrangler:info] Ready');
    expect(slice).toContain('[wrangler:error] TypeError');
    expect(slice).toContain('    at someFunction');
  });

  it('ignores markers belonging to a different runId', () => {
    const raw = [
      startMarker(OTHER_RUN_ID),
      reqLine(MOBILE_VERSION, '/not-mine'),
      endMarker(OTHER_RUN_ID),
      startMarker(RUN_ID),
      reqLine(MOBILE_VERSION, '/mine'),
      endMarker(RUN_ID),
    ].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
      mobileVersion: MOBILE_VERSION,
    });

    expect(slice).toContain('/mine');
    expect(slice).not.toContain('/not-mine');
    expect(slice).not.toContain(startMarker(OTHER_RUN_ID));
  });

  it('uses the latest START when the same runId appears multiple times', () => {
    const raw = [
      startMarker(RUN_ID, '2026-05-26T01:00:00.000Z'),
      reqLine(MOBILE_VERSION, '/earlier'),
      endMarker(RUN_ID, '2026-05-26T01:05:00.000Z'),
      startMarker(RUN_ID, '2026-05-26T03:00:00.000Z'),
      reqLine(MOBILE_VERSION, '/later'),
      endMarker(RUN_ID, '2026-05-26T03:05:00.000Z'),
    ].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
      mobileVersion: MOBILE_VERSION,
    });

    expect(slice).toContain('/later');
    expect(slice).not.toContain('/earlier');
  });

  it('treats a [req] line with no v= as non-matching (filtered out)', () => {
    const raw = [
      startMarker(RUN_ID),
      '[req] 2026-05-26T03:18:42.119Z POST /no-version 200 100ms',
      reqLine(MOBILE_VERSION, '/mine'),
      endMarker(RUN_ID),
    ].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
      mobileVersion: MOBILE_VERSION,
    });

    expect(slice).not.toContain('/no-version');
    expect(slice).toContain('/mine');
  });

  it('handles empty rawLog', () => {
    expect(extractRelevantSlice({ rawLog: '', runId: RUN_ID, mobileVersion: MOBILE_VERSION })).toBe(
      ''
    );
  });
});
