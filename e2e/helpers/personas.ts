import { test } from '@playwright/test';

/**
 * Project-aware persona email. Must be called inside a test/fixture — reads
 * `test.info().project.name` lazily. `test-alice` + project `chromium` →
 * `test-alice-chromium@test.hushbox.ai`.
 */
export function personaEmail(baseName: string, projectName?: string): string {
  const project = projectName ?? test.info().project.name;
  return `${baseName}-${project}@test.hushbox.ai`;
}
