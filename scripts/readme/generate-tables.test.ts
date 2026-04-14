import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPARISON_ROWS } from '../../packages/shared/src/comparison.js';
import { getBrandColors } from './brand.js';
import {
  generateComparisonSvg,
  generatePricingSvg,
  generateTables,
  generateTiersSvg,
} from './generate-tables.js';

const REPO_ROOT = path.resolve(import.meta.dirname ?? '.', '../..');

describe('generateComparisonSvg', () => {
  it('renders every comparison row label', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generateComparisonSvg({ width: 720, theme: brand.light });

    for (const row of COMPARISON_ROWS) {
      expect(svg).toContain(row.label);
    }
  });

  it('includes HUSHBOX and OTHERS headers', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generateComparisonSvg({ width: 720, theme: brand.light });

    expect(svg).toContain('HUSHBOX');
    expect(svg).toContain('OTHERS');
  });

  it('uses brand colors from the CSS', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generateComparisonSvg({ width: 720, theme: brand.dark });

    expect(svg).toContain(brand.dark.brandRed);
    expect(svg).toContain(brand.dark.background);
  });
});

describe('generatePricingSvg', () => {
  it('shows all four fee slices', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generatePricingSvg({ width: 720, theme: brand.light });

    expect(svg).toContain('HushBox');
    expect(svg).toContain('Card processing');
    expect(svg).toContain('Provider overhead');
    expect(svg).toContain('Total');
  });

  it('shows percentages derived from constants', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generatePricingSvg({ width: 720, theme: brand.light });

    expect(svg).toContain('5%');
    expect(svg).toContain('4.5%');
    expect(svg).toContain('5.5%');
    expect(svg).toContain('15%');
  });
});

describe('generateTiersSvg', () => {
  it('shows TRIAL, FREE, PAID headers', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generateTiersSvg({ width: 720, theme: brand.light });

    expect(svg).toContain('TRIAL');
    expect(svg).toContain('FREE');
    expect(svg).toContain('PAID');
  });

  it('shows trial limit and free allowance from constants', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generateTiersSvg({ width: 720, theme: brand.light });

    expect(svg).toContain('5 messages');
    expect(svg).toContain('$0.05');
  });
});

describe('generateTables', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'tables-test-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('writes 6 SVG files (comparison/pricing/tiers × dark/light)', () => {
    generateTables(temporaryDir, REPO_ROOT);
    const files = readdirSync(temporaryDir);

    expect(files).toContain('comparison-dark.svg');
    expect(files).toContain('comparison-light.svg');
    expect(files).toContain('pricing-dark.svg');
    expect(files).toContain('pricing-light.svg');
    expect(files).toContain('tiers-dark.svg');
    expect(files).toContain('tiers-light.svg');
  });

  it('produces valid SVG files', () => {
    generateTables(temporaryDir, REPO_ROOT);
    const content = readFileSync(path.join(temporaryDir, 'comparison-dark.svg'), 'utf8');

    expect(content).toContain('<svg');
    expect(content).toContain('</svg>');
    expect(content).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
});
