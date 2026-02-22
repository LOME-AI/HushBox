import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDIT_CARD_FEE_RATE,
  HUSHBOX_FEE_RATE,
  PROVIDER_FEE_RATE,
  STORAGE_COST_PER_1K_CHARS,
  STORAGE_COST_PER_CHARACTER,
  TOTAL_FEE_RATE,
} from '../packages/shared/src/constants.js';
import { generateReadme, getTemplateValues } from './generate-readme.js';

describe('getTemplateValues', () => {
  it('returns fee percentages derived from constants', () => {
    const values = getTemplateValues();

    expect(values['TOTAL_FEE_PERCENT']).toBe(`${String(TOTAL_FEE_RATE * 100)}%`);
    expect(values['HUSHBOX_FEE_PERCENT']).toBe(`${String(HUSHBOX_FEE_RATE * 100)}%`);
    expect(values['CC_FEE_PERCENT']).toBe(`${String(CREDIT_CARD_FEE_RATE * 100)}%`);
    expect(values['PROVIDER_FEE_PERCENT']).toBe(`${String(PROVIDER_FEE_RATE * 100)}%`);
  });

  it('returns storage cost from constants', () => {
    const values = getTemplateValues();

    expect(values['STORAGE_COST_PER_1K']).toBe(`$${String(STORAGE_COST_PER_1K_CHARS)}`);
  });

  it('calculates messages per dollar correctly', () => {
    const values = getTemplateValues();
    const averageMessageChars = 200;
    const expectedMessages = Math.floor(1 / (STORAGE_COST_PER_CHARACTER * averageMessageChars));

    expect(values['MESSAGES_PER_DOLLAR']).toBe(expectedMessages.toLocaleString('en-US'));
  });

  it('returns 16,666 messages per dollar with current constants', () => {
    const values = getTemplateValues();

    // With STORAGE_COST_PER_CHARACTER = 0.0000003 and 200 chars/message:
    // 1 / (0.0000003 * 200) = 1 / 0.00006 = 16666.67 → 16666
    expect(values['MESSAGES_PER_DOLLAR']).toBe('16,666');
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

  it('lists all unique unmatched variables', () => {
    const template = `{{UNKNOWN_A}} {{UNKNOWN_B}} {{UNKNOWN_A}}`;
    writeFileSync(path.join(temporaryDir, 'README.template.md'), template);

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errorCalls: string[] = [];
    const mockError = vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      errorCalls.push(msg);
    });

    expect(() => {
      generateReadme(temporaryDir);
    }).toThrow('process.exit called');

    // Should list each unique variable once
    const variableLines = errorCalls.filter((c) => c.startsWith('  - '));
    expect(variableLines).toHaveLength(2);
    expect(variableLines).toContain('  - {{UNKNOWN_A}}');
    expect(variableLines).toContain('  - {{UNKNOWN_B}}');

    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it('succeeds when all variables are matched', () => {
    const template = `{{TOTAL_FEE_PERCENT}} {{HUSHBOX_FEE_PERCENT}} {{CC_FEE_PERCENT}} {{PROVIDER_FEE_PERCENT}} {{STORAGE_COST_PER_1K}} {{MESSAGES_PER_DOLLAR}}`;
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
