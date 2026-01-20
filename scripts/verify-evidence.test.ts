import { describe, it, expect } from 'vitest';
import { parseCliArgs, formatResult } from './verify-evidence.js';

describe('parseCliArgs', () => {
  it('parses --require with single service', () => {
    const result = parseCliArgs(['--require=openrouter']);

    expect(result).toEqual({ require: ['openrouter'] });
  });

  it('parses --require with multiple services', () => {
    const result = parseCliArgs(['--require=openrouter,hookdeck']);

    expect(result).toEqual({ require: ['openrouter', 'hookdeck'] });
  });

  it('returns error when --require is missing', () => {
    const result = parseCliArgs([]);

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Usage:');
  });

  it('returns error for invalid service name', () => {
    const result = parseCliArgs(['--require=invalid']);

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Invalid service');
  });

  it('returns error when one of multiple services is invalid', () => {
    const result = parseCliArgs(['--require=openrouter,invalid']);

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Invalid service');
  });

  it('handles whitespace in service list', () => {
    const result = parseCliArgs(['--require=openrouter, hookdeck']);

    expect(result).toEqual({ require: ['openrouter', 'hookdeck'] });
  });
});

describe('formatResult', () => {
  it('formats success with single service', () => {
    const output = formatResult({ success: true, missing: [] }, ['openrouter']);

    expect(output).toContain('✓');
    expect(output).toContain('openrouter');
  });

  it('formats success with multiple services', () => {
    const output = formatResult({ success: true, missing: [] }, ['openrouter', 'hookdeck']);

    expect(output).toContain('✓');
    expect(output).toContain('openrouter');
    expect(output).toContain('hookdeck');
  });

  it('formats failure with missing services', () => {
    const output = formatResult({ success: false, missing: ['hookdeck'] }, [
      'openrouter',
      'hookdeck',
    ]);

    expect(output).toContain('✗');
    expect(output).toContain('hookdeck');
  });

  it('includes explanation for missing services', () => {
    const output = formatResult({ success: false, missing: ['openrouter'] }, ['openrouter']);

    expect(output).toContain('mocks');
  });
});
