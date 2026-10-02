import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { SERVICE_NAMES } from '@hushbox/db';
import { parseCliArgs, formatResult } from './verify-evidence.js';

/**
 * The usage examples are prose — a JSDoc block and an error string — so this
 * read of the script's own text is the only thing holding them to names the
 * registry still declares. Both spellings of the flag's value slot are read,
 * because {@link parseCliArgs} accepts both: `--require=x` and `--require x`.
 */
const SOURCE = readFileSync(fileURLToPath(new URL('verify-evidence.ts', import.meta.url)), 'utf8');
const EXAMPLES = [...SOURCE.matchAll(/--require[= ]([\w,-]+)/g)].map(([, example = '']) => example);

describe('parseCliArgs', () => {
  it('refuses a flag it does not recognise rather than reading past it', () => {
    expect(parseCliArgs(['--verbose', '--require=openrouter-catalog'])).toEqual({
      error: expect.stringContaining('--verbose') as unknown as string,
    });
  });

  it('answers a usage request with the usage text', () => {
    expect(parseCliArgs(['--help'])).toEqual({
      error: expect.stringContaining('pnpm verify:evidence') as unknown as string,
    });
  });

  it('parses --require with single service', () => {
    const result = parseCliArgs(['--require=openrouter-catalog']);

    expect(result).toEqual({ require: ['openrouter-catalog'] });
  });

  it('parses --require with multiple services', () => {
    const result = parseCliArgs(['--require=openrouter-catalog,helcim-webhook']);

    expect(result).toEqual({ require: ['openrouter-catalog', 'helcim-webhook'] });
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
    const result = parseCliArgs(['--require=openrouter-catalog,invalid']);

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Invalid service');
  });

  it('handles whitespace in service list', () => {
    const result = parseCliArgs(['--require=openrouter-catalog, helcim-webhook']);

    expect(result).toEqual({ require: ['openrouter-catalog', 'helcim-webhook'] });
  });

  it('accepts the r2-storage and r2-gc service names', () => {
    expect(parseCliArgs(['--require=r2-storage'])).toEqual({ require: ['r2-storage'] });
    expect(parseCliArgs(['--require=r2-gc'])).toEqual({ require: ['r2-gc'] });
  });
});

describe('usage examples', () => {
  it('names only services the registry declares', () => {
    const declared: string[] = Object.values(SERVICE_NAMES);
    const named = EXAMPLES.flatMap((example) => example.split(','));

    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((service) => !declared.includes(service))).toEqual([]);
  });
});

describe('formatResult', () => {
  it('formats success with single service', () => {
    const output = formatResult({ success: true, missing: [] }, ['openrouter-catalog']);

    expect(output).toContain('✓');
    expect(output).toContain('openrouter-catalog');
  });

  it('formats success with multiple services', () => {
    const output = formatResult({ success: true, missing: [] }, [
      'openrouter-catalog',
      'helcim-webhook',
    ]);

    expect(output).toContain('✓');
    expect(output).toContain('openrouter-catalog');
    expect(output).toContain('helcim-webhook');
  });

  it('formats failure with missing services', () => {
    const output = formatResult({ success: false, missing: ['helcim-webhook'] }, [
      'openrouter-catalog',
      'helcim-webhook',
    ]);

    expect(output).toContain('✗');
    expect(output).toContain('helcim-webhook');
  });

  it('includes explanation for missing services', () => {
    const output = formatResult({ success: false, missing: ['openrouter-catalog'] }, [
      'openrouter-catalog',
    ]);

    expect(output).toContain('mocks');
  });
});
