import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectReadmeInputs, generateReadme, getTemplateValues } from './generate-readme.js';
import { countLinesOfCode } from './lines-of-code.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

describe('collectReadmeInputs', () => {
  // withCache skips hash persistence entirely when any input is missing, so an
  // unresolvable input silently turns the cache off instead of failing.
  it('declares only paths that exist on disk', () => {
    const missing = collectReadmeInputs(REPO_ROOT).filter((file) => !existsSync(file));

    expect(missing).toEqual([]);
  });

  // Template prices reach README.md through the nano-USD formatter, below the
  // pricing constants this generator imports by name.
  it('declares the money formatter the rendered prices pass through', () => {
    const inputs = collectReadmeInputs(REPO_ROOT);

    expect(inputs).toContain(
      realpathSync(path.join(REPO_ROOT, 'packages/shared/src/affordability/money/nano-usd.ts'))
    );
  });

  // The rendered percentages are the shared fee formatter's output, so a change
  // to its rounding must invalidate the cache the same way a rate change does.
  it('declares the fee formatter the rendered percentages pass through', () => {
    const inputs = collectReadmeInputs(REPO_ROOT);

    expect(inputs).toContain(
      realpathSync(path.join(REPO_ROOT, 'packages/shared/src/affordability/money/fees.ts'))
    );
  });

  it('declares the module holding the card-loading minimum', () => {
    const inputs = collectReadmeInputs(REPO_ROOT);

    expect(inputs).toContain(
      realpathSync(path.join(REPO_ROOT, 'packages/shared/src/constants.ts'))
    );
  });
});

describe('getTemplateValues', () => {
  it('returns fee percentages derived from constants', () => {
    const values = getTemplateValues();

    expect(values['TOTAL_FEE_PERCENT']).toBe('15%');
    expect(values['HUSHBOX_FEE_PERCENT']).toBe('5%');
    expect(values['CC_FEE_PERCENT']).toBe('4.5%');
    expect(values['PROVIDER_FEE_PERCENT']).toBe('5.5%');
  });

  it('returns storage cost from constants', () => {
    const values = getTemplateValues();

    expect(values['STORAGE_COST_PER_1K']).toBe('$0.0003');
  });

  it('returns 16,666 messages per dollar with current constants', () => {
    const values = getTemplateValues();

    expect(values['MESSAGES_PER_DOLLAR']).toBe('16,666');
  });

  it('returns the card-loading minimum from constants', () => {
    const values = getTemplateValues();

    expect(values['MIN_DEPOSIT']).toBe('$5');
  });

  it('includes tier-related values', () => {
    const values = getTemplateValues();

    expect(values['FREE_ALLOWANCE']).toBe('$0.05');
    expect(values['TRIAL_LIMIT']).toBe('5');
    expect(values['WELCOME_CREDIT']).toBe('$0.20');
  });
});

describe('generateReadme', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'generate-readme-test-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('replaces template variables with values', () => {
    const template = `# Test
Fee: {{TOTAL_FEE_PERCENT}}
Storage: {{STORAGE_COST_PER_1K}} per 1k chars
`;
    writeFileSync(path.join(temporaryDir, 'README.template.md'), template);

    generateReadme(temporaryDir);

    const output = readFileSync(path.join(temporaryDir, 'README.md'), 'utf8');
    expect(output).toContain('Fee: 15%');
    expect(output).toContain('Storage: $0.0003 per 1k chars');
  });

  it('replaces the lines-of-code variable with the repo line count', () => {
    writeFileSync(
      path.join(temporaryDir, 'count-me.ts'),
      'const a = 1;\nconst b = 2;\nconst c = 3;\n'
    );
    writeFileSync(path.join(temporaryDir, 'README.template.md'), 'Lines: {{LINES_OF_CODE}}');
    // Computed at the same filesystem state generateReadme sees (before it writes
    // README.md), so the assertion is independent of the counted-extension set.
    const expected = countLinesOfCode(temporaryDir);

    generateReadme(temporaryDir);

    const output = readFileSync(path.join(temporaryDir, 'README.md'), 'utf8');
    expect(output).toContain(`Lines: ${expected.toLocaleString('en-US')}`);
  });

  it('formats the line count with thousands separators', () => {
    writeFileSync(path.join(temporaryDir, 'big.ts'), 'x\n'.repeat(1234));
    writeFileSync(path.join(temporaryDir, 'README.template.md'), '{{LINES_OF_CODE}}');
    const expected = countLinesOfCode(temporaryDir);

    generateReadme(temporaryDir);

    const output = readFileSync(path.join(temporaryDir, 'README.md'), 'utf8');
    expect(expected).toBeGreaterThan(999);
    expect(output).toContain(expected.toLocaleString('en-US'));
  });

  it('adds auto-generated notice at top', () => {
    const template = '# Hello';
    writeFileSync(path.join(temporaryDir, 'README.template.md'), template);

    generateReadme(temporaryDir);

    const output = readFileSync(path.join(temporaryDir, 'README.md'), 'utf8');
    expect(output.startsWith('<!-- AUTO-GENERATED from README.template.md')).toBe(true);
  });

  it('replaces all occurrences of same variable', () => {
    const template = `{{TOTAL_FEE_PERCENT}} here and {{TOTAL_FEE_PERCENT}} there`;
    writeFileSync(path.join(temporaryDir, 'README.template.md'), template);

    generateReadme(temporaryDir);

    const output = readFileSync(path.join(temporaryDir, 'README.md'), 'utf8');
    expect(output).toContain('15% here and 15% there');
  });

  it('exits with code 1 when unmatched variables found', () => {
    const template = `Valid: {{TOTAL_FEE_PERCENT}}, Invalid: {{UNKNOWN_VAR}}`;
    writeFileSync(path.join(temporaryDir, 'README.template.md'), template);

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const mockError = vi.spyOn(console, 'error').mockImplementation(vi.fn());

    expect(() => {
      generateReadme(temporaryDir);
    }).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith('ERROR: Unmatched template variables found:');
    expect(mockError).toHaveBeenCalledWith('  - {{UNKNOWN_VAR}}');

    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it('succeeds when all variables are matched', () => {
    const template = `{{TOTAL_FEE_PERCENT}} {{HUSHBOX_FEE_PERCENT}} {{CC_FEE_PERCENT}} {{PROVIDER_FEE_PERCENT}} {{STORAGE_COST_PER_1K}} {{MESSAGES_PER_DOLLAR}} {{FREE_ALLOWANCE}} {{TRIAL_LIMIT}} {{WELCOME_CREDIT}} {{MIN_DEPOSIT}} {{LINES_OF_CODE}}`;
    writeFileSync(path.join(temporaryDir, 'README.template.md'), template);

    const mockExit = vi.spyOn(process, 'exit');
    const mockLog = vi.spyOn(console, 'log').mockImplementation(vi.fn());

    generateReadme(temporaryDir);

    expect(mockExit).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith('✓ Generated README.md from template');

    mockExit.mockRestore();
    mockLog.mockRestore();
  });
});
