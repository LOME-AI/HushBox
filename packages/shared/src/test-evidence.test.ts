import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { recordServiceCall, verifyEvidence, EVIDENCE_FILE } from './test-evidence.js';

vi.mock('node:fs');

describe('recordServiceCall', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('does nothing when not in CI', () => {
    delete process.env['CI'];

    recordServiceCall('openrouter');

    expect(fs.appendFileSync).not.toHaveBeenCalled();
  });

  it('writes evidence to file when in CI', () => {
    process.env['CI'] = 'true';

    recordServiceCall('openrouter');

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      EVIDENCE_FILE,
      expect.stringContaining('"service":"openrouter"')
    );
  });

  it('includes timestamp in evidence', () => {
    process.env['CI'] = 'true';

    recordServiceCall('hookdeck');

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      EVIDENCE_FILE,
      expect.stringContaining('"timestamp":')
    );
  });

  it('includes optional details in evidence', () => {
    process.env['CI'] = 'true';

    recordServiceCall('hookdeck', { transactionId: 'tx-123' });

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      EVIDENCE_FILE,
      expect.stringContaining('"transactionId":"tx-123"')
    );
  });

  it('appends newline after each entry', () => {
    process.env['CI'] = 'true';

    recordServiceCall('openrouter');

    expect(fs.appendFileSync).toHaveBeenCalledWith(EVIDENCE_FILE, expect.stringMatching(/\n$/));
  });

  it('writes valid JSON', () => {
    process.env['CI'] = 'true';

    recordServiceCall('openrouter', { generationId: 'gen-456' });

    const calls = vi.mocked(fs.appendFileSync).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0] as [string, string];
    const writtenData = firstCall[1];
    const jsonLine = writtenData.trim();

    const parsed: unknown = JSON.parse(jsonLine);
    expect(parsed).toMatchObject({
      service: 'openrouter',
      details: { generationId: 'gen-456' },
    });
  });
});

describe('verifyEvidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns missing services when evidence file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = verifyEvidence(['openrouter', 'hookdeck']);

    expect(result.success).toBe(false);
    expect(result.missing).toEqual(['openrouter', 'hookdeck']);
  });

  it('returns success when all required services found', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      '{"service":"openrouter","timestamp":"2024-01-01T00:00:00Z"}\n' +
        '{"service":"hookdeck","timestamp":"2024-01-01T00:00:01Z"}\n'
    );

    const result = verifyEvidence(['openrouter', 'hookdeck']);

    expect(result.success).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('returns missing services not found in evidence', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      '{"service":"openrouter","timestamp":"2024-01-01T00:00:00Z"}\n'
    );

    const result = verifyEvidence(['openrouter', 'hookdeck']);

    expect(result.success).toBe(false);
    expect(result.missing).toEqual(['hookdeck']);
  });

  it('handles empty evidence file', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('');

    const result = verifyEvidence(['openrouter']);

    expect(result.success).toBe(false);
    expect(result.missing).toEqual(['openrouter']);
  });

  it('handles multiple calls to same service', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      '{"service":"openrouter","timestamp":"2024-01-01T00:00:00Z"}\n' +
        '{"service":"openrouter","timestamp":"2024-01-01T00:00:01Z"}\n' +
        '{"service":"openrouter","timestamp":"2024-01-01T00:00:02Z"}\n'
    );

    const result = verifyEvidence(['openrouter']);

    expect(result.success).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('succeeds when requiring empty list', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = verifyEvidence([]);

    expect(result.success).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

describe('EVIDENCE_FILE', () => {
  it('is a tmp file path', () => {
    expect(EVIDENCE_FILE).toMatch(/^\/tmp\//);
  });

  it('is a jsonl file', () => {
    expect(EVIDENCE_FILE).toMatch(/\.jsonl$/);
  });
});
