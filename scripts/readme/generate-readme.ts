import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  TOTAL_FEE_RATE,
  HUSHBOX_FEE_RATE,
  CREDIT_CARD_FEE_RATE,
  PROVIDER_FEE_RATE,
  STORAGE_COST_PER_CHARACTER,
  STORAGE_COST_PER_1K_CHARS,
} from '../../packages/shared/src/constants.js';
import {
  FREE_ALLOWANCE_CENTS_VALUE,
  TRIAL_MESSAGE_LIMIT,
  WELCOME_CREDIT_CENTS,
} from '../../packages/shared/src/tiers.js';
import { withCache } from './cache.js';

/** Average characters per message for marketing calculations */
const AVERAGE_MESSAGE_CHARS = 200;

/**
 * Get all template values derived from code constants.
 * These replace {{VARIABLE}} placeholders in README.template.md.
 */
export function getTemplateValues(): Record<string, string> {
  const messagesPerDollar = Math.floor(1 / (STORAGE_COST_PER_CHARACTER * AVERAGE_MESSAGE_CHARS));

  return {
    TOTAL_FEE_PERCENT: `${String(TOTAL_FEE_RATE * 100)}%`,
    HUSHBOX_FEE_PERCENT: `${String(HUSHBOX_FEE_RATE * 100)}%`,
    CC_FEE_PERCENT: `${String(CREDIT_CARD_FEE_RATE * 100)}%`,
    PROVIDER_FEE_PERCENT: `${String(PROVIDER_FEE_RATE * 100)}%`,
    STORAGE_COST_PER_1K: `$${String(STORAGE_COST_PER_1K_CHARS)}`,
    MESSAGES_PER_DOLLAR: messagesPerDollar.toLocaleString('en-US'),
    FREE_ALLOWANCE: `$${(FREE_ALLOWANCE_CENTS_VALUE / 100).toFixed(2)}`,
    TRIAL_LIMIT: String(TRIAL_MESSAGE_LIMIT),
    WELCOME_CREDIT: `$${(WELCOME_CREDIT_CENTS / 100).toFixed(2)}`,
  };
}

/** Files whose contents determine the README output. */
export function collectReadmeInputs(rootDir: string): string[] {
  return [
    path.join(rootDir, 'scripts/readme/generate-readme.ts'),
    path.join(rootDir, 'README.template.md'),
    path.join(rootDir, 'packages/shared/src/constants.ts'),
    path.join(rootDir, 'packages/shared/src/tiers.ts'),
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
      const values = getTemplateValues();

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

// CLI entry point
/* v8 ignore next 2 */
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) generateReadme(process.cwd());
