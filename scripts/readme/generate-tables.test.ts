import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPARISON_ROWS } from '../../packages/shared/src/comparison.js';
import {
  ALL_FEE_CATEGORIES,
  FEE_CATEGORIES,
  formatFeePercent,
} from '../../packages/shared/src/affordability/money/fees.js';
import { TOTAL_FEE_RATE } from '../../packages/shared/src/affordability/constants.js';
import {
  centsToNanoUsd,
  nanoUsdToDollarString,
} from '../../packages/shared/src/affordability/money/nano-usd.js';
import { FREE_ALLOWANCE_CENTS_VALUE } from '../../packages/shared/src/affordability/money/tiers.js';
import { getBrandColors } from './brand.js';
import {
  collectTableInputs,
  generateComparisonSvg,
  generatePricingSvg,
  generateTables,
  generateTiersSvg,
} from './generate-tables.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

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
  it('shows one row per non-zero fee category plus a Total row', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generatePricingSvg({ width: 720, theme: brand.light });

    for (const category of FEE_CATEGORIES) {
      expect(svg).toContain(category.shortLabel);
    }
    expect(svg).toContain('Total');
  });

  it('shows the total fee rate and every non-zero category percent derived from constants', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generatePricingSvg({ width: 720, theme: brand.light });

    for (const category of FEE_CATEGORIES) {
      expect(svg).toContain(formatFeePercent(category.rate));
    }
    expect(svg).toContain(formatFeePercent(TOTAL_FEE_RATE));
  });

  it('does not render any row for a zero-rate fee category', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generatePricingSvg({ width: 720, theme: brand.light });

    for (const category of ALL_FEE_CATEGORIES) {
      if (category.rate === 0) {
        expect(svg).not.toContain(category.shortLabel);
        expect(svg).not.toContain(category.description);
      }
    }
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
    expect(svg).toContain(`$${nanoUsdToDollarString(centsToNanoUsd(FREE_ALLOWANCE_CENTS_VALUE))}`);
  });
});

describe('collectTableInputs', () => {
  // withCache skips hash persistence entirely when any input is missing, so an
  // unresolvable input silently turns the cache off instead of failing.
  it('declares only paths that exist on disk', () => {
    const missing = collectTableInputs(REPO_ROOT).filter((file) => !existsSync(file));

    expect(missing).toEqual([]);
  });

  // Prices reach the SVGs through the nano-USD formatter, two modules below the
  // pricing constants this generator imports by name.
  it('declares the money formatter the rendered prices pass through', () => {
    const inputs = collectTableInputs(REPO_ROOT);

    expect(inputs).toContain(
      realpathSync(path.join(REPO_ROOT, 'packages/shared/src/affordability/money/nano-usd.ts'))
    );
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

  it('records the freshness hash inside the directory it generated into', () => {
    generateTables(temporaryDir, REPO_ROOT);

    expect(existsSync(path.join(temporaryDir, '.cache/tables.hash'))).toBe(true);
  });

  // The hash certifies that a set of outputs matches the inputs. Stamping it
  // against the repository while the SVGs went somewhere else lets the
  // pre-commit hook skip regeneration and commit stale artifacts under a hash
  // that says they are fresh.
  it('leaves the repository freshness hash untouched', () => {
    const repositoryHash = path.join(REPO_ROOT, '.github/readme/.cache/tables.hash');
    const before = statSync(repositoryHash, { bigint: true }).mtimeNs;

    generateTables(temporaryDir, REPO_ROOT);

    expect(statSync(repositoryHash, { bigint: true }).mtimeNs).toBe(before);
  });

  it('produces valid SVG files', () => {
    generateTables(temporaryDir, REPO_ROOT);
    const content = readFileSync(path.join(temporaryDir, 'comparison-dark.svg'), 'utf8');

    expect(content).toContain('<svg');
    expect(content).toContain('</svg>');
    expect(content).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('defaults to process.cwd() as the repo root when none is given', () => {
    const originalCwd = process.cwd();
    process.chdir(REPO_ROOT);
    try {
      generateTables(temporaryDir);

      expect(readdirSync(temporaryDir)).toContain('comparison-dark.svg');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
