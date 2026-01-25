import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  TOTAL_FEE_RATE,
  LOME_FEE_RATE,
  CREDIT_CARD_FEE_RATE,
  PROVIDER_FEE_RATE,
  STORAGE_COST_PER_CHARACTER,
  STORAGE_COST_PER_1K_CHARS,
} from '../packages/shared/src/constants.js';

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
    LOME_FEE_PERCENT: `${String(LOME_FEE_RATE * 100)}%`,
    CC_FEE_PERCENT: `${String(CREDIT_CARD_FEE_RATE * 100)}%`,
    PROVIDER_FEE_PERCENT: `${String(PROVIDER_FEE_RATE * 100)}%`,
    STORAGE_COST_PER_1K: `$${String(STORAGE_COST_PER_1K_CHARS)}`,
    MESSAGES_PER_DOLLAR: messagesPerDollar.toLocaleString('en-US'),
  };
}

/**
 * Generate README.md from README.template.md using code constants.
 * Exits with code 1 if any template variables are unmatched (blocks commit).
 */
export function generateReadme(rootDir: string): void {
  const templatePath = path.resolve(rootDir, 'README.template.md');
  const outputPath = path.resolve(rootDir, 'README.md');

  let content = readFileSync(templatePath, 'utf8');
  const values = getTemplateValues();

  // Replace all known placeholders
  for (const [key, value] of Object.entries(values)) {
    content = content.replaceAll(new RegExp(String.raw`\{\{${key}\}\}`, 'g'), value);
  }

  // Check for any remaining unmatched placeholders - BLOCK COMMIT if found
  const unmatchedVariables = content.match(/\{\{[A-Z_]+\}\}/g);
  if (unmatchedVariables) {
    console.error('ERROR: Unmatched template variables found:');
    for (const v of new Set(unmatchedVariables)) {
      console.error(`  - ${v}`);
    }
    console.error('Add these to getTemplateValues() in scripts/generate-readme.ts');
    process.exit(1);
  }

  // Add generation notice
  const notice = '<!-- AUTO-GENERATED from README.template.md - Do not edit directly -->\n\n';
  content = notice + content;

  writeFileSync(outputPath, content);
  console.log('✓ Generated README.md from template');
}

// CLI entry point
/* v8 ignore next 2 */
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) generateReadme(process.cwd());
