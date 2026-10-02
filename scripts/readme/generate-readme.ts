import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMainModule } from '../lib/cli/is-main.js';
import { readCommandLineOrRefuse, type CommandSpec } from '../lib/cli/command-line.js';
import {
  TOTAL_FEE_RATE,
  HUSHBOX_FEE_RATE,
  CREDIT_CARD_FEE_RATE,
  PROVIDER_FEE_RATE,
  STORAGE_COST_PER_CHARACTER,
  STORAGE_COST_PER_1K_CHARS,
} from '../../packages/shared/src/affordability/constants.js';
import {
  FREE_ALLOWANCE_CENTS_VALUE,
  TRIAL_MESSAGE_LIMIT,
  WELCOME_CREDIT_CENTS,
} from '../../packages/shared/src/affordability/money/tiers.js';
import { formatFeePercent } from '../../packages/shared/src/affordability/money/fees.js';
import {
  centsToNanoUsd,
  nanoUsdToDollarString,
} from '../../packages/shared/src/affordability/money/nano-usd.js';
import { MIN_DEPOSIT_USD } from '../../packages/shared/src/constants.js';
import { withCache } from './cache.js';
import { collectModuleClosure } from './module-closure.js';
import { countLinesOfCode } from './lines-of-code.js';

/** Average characters per message for marketing calculations */
const AVERAGE_MESSAGE_CHARS = 200;

/**
 * Get all template values derived from code constants.
 * These replace {{VARIABLE}} placeholders in README.template.md.
 */
export function getTemplateValues(): Record<string, string> {
  const messagesPerDollar = Math.floor(1 / (STORAGE_COST_PER_CHARACTER * AVERAGE_MESSAGE_CHARS));

  return {
    TOTAL_FEE_PERCENT: formatFeePercent(TOTAL_FEE_RATE),
    HUSHBOX_FEE_PERCENT: formatFeePercent(HUSHBOX_FEE_RATE),
    CC_FEE_PERCENT: formatFeePercent(CREDIT_CARD_FEE_RATE),
    PROVIDER_FEE_PERCENT: formatFeePercent(PROVIDER_FEE_RATE),
    STORAGE_COST_PER_1K: `$${String(STORAGE_COST_PER_1K_CHARS)}`,
    MESSAGES_PER_DOLLAR: messagesPerDollar.toLocaleString('en-US'),
    FREE_ALLOWANCE: `$${nanoUsdToDollarString(centsToNanoUsd(FREE_ALLOWANCE_CENTS_VALUE))}`,
    TRIAL_LIMIT: String(TRIAL_MESSAGE_LIMIT),
    WELCOME_CREDIT: `$${nanoUsdToDollarString(centsToNanoUsd(WELCOME_CREDIT_CENTS))}`,
    MIN_DEPOSIT: `$${String(MIN_DEPOSIT_USD)}`,
  };
}

/** Files whose contents determine the README output. */
export function collectReadmeInputs(rootDir: string): string[] {
  return [
    ...collectModuleClosure([path.join(rootDir, 'scripts/readme/generate-readme.ts')]),
    // Read at run time rather than imported, so no import walk can see it.
    path.join(rootDir, 'README.template.md'),
  ];
}

/**
 * Generate README.md from README.template.md using code constants and shared data.
 * Exits with code 1 if any template variables are unmatched (blocks commit).
 * Cached: skips when inputs and README.md are unchanged.
 */
export function generateReadme(rootDir: string): void {
  const templatePath = path.resolve(rootDir, 'README.template.md');
  const outputPath = path.resolve(rootDir, 'README.md');

  withCache(
    {
      label: 'README',
      hashPath: path.join(rootDir, '.github/readme/.cache/readme.hash'),
      inputs: collectReadmeInputs(rootDir),
      outputs: [outputPath],
    },
    () => {
      let content = readFileSync(templatePath, 'utf8');
      const values = {
        ...getTemplateValues(),
        // Counted at generation time from the repo tree, so it tracks the
        // source rather than a hand-maintained constant.
        LINES_OF_CODE: countLinesOfCode(rootDir).toLocaleString('en-US'),
      };

      for (const [key, value] of Object.entries(values)) {
        content = content.replaceAll(new RegExp(String.raw`\{\{${key}\}\}`, 'g'), value);
      }

      const unmatchedVariables = content.match(/\{\{[A-Z_]+\}\}/g);
      if (unmatchedVariables) {
        console.error('ERROR: Unmatched template variables found:');
        for (const v of new Set(unmatchedVariables)) {
          console.error(`  - ${v}`);
        }
        console.error('Add these to getTemplateValues() in scripts/readme/generate-readme.ts');
        process.exit(1);
      }

      const notice = '<!-- AUTO-GENERATED from README.template.md - Do not edit directly -->\n\n';
      content = notice + content;

      writeFileSync(outputPath, content);
      console.log('✓ Generated README.md from template');
    }
  );
}

export const COMMAND_LINE = {
  command: 'pnpm generate:readme',
  summary: 'Writes README.md from its template.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI wiring; the generator is covered via unit tests */
const isMain = isMainModule(import.meta.url);
if (isMain && readCommandLineOrRefuse(COMMAND_LINE, process.argv.slice(2)) !== null)
  generateReadme(process.cwd());
/* v8 ignore stop */
