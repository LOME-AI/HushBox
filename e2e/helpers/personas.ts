import { test } from '@playwright/test';
import { TEST_PERSONAS, testPersonaName, type E2EProjectName } from '../../scripts/seed.js';

/**
 * Project-aware persona email. Must be called inside a test/fixture — reads
 * `test.info().project.name` lazily. `test-alice` + project `chromium` →
 * `test-alice-chromium@test.hushbox.ai`.
 */
export function personaEmail(baseName: string, projectName?: string): string {
  const project = projectName ?? test.info().project.name;
  return `${baseName}-${project}@test.hushbox.ai`;
}

/**
 * Project-aware persona SQL username — single source of truth is the seeded
 * `TEST_PERSONAS` array in `scripts/seed.ts`. `test-alice` + project `chromium`
 * → `test_alice_cr`. Tests that previously hardcoded display strings like
 * `'test dave'` predate the persona×project cross-product (those resolved to
 * a single un-suffixed `test_dave` row that no longer exists); route them
 * through this helper so search/login lookups match exactly one user.
 */
export function personaUsername(baseName: string, projectName?: string): string {
  const project = (projectName ?? test.info().project.name) as E2EProjectName;
  const fullName = testPersonaName(baseName, project);
  const persona = TEST_PERSONAS.find((p) => p.name === fullName);
  if (!persona) {
    throw new Error(
      `personaUsername: no seeded persona for "${fullName}" (baseName=${baseName}, project=${project})`
    );
  }
  return persona.username;
}
