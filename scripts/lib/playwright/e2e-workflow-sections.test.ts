import { describe, expect, it } from 'vitest';

import { generateE2eMatrix, generateE2eRunSet } from './e2e-workflow-sections.js';
import { E2E_PROJECTS } from './projects.js';

describe('generateE2eMatrix', () => {
  it('marks the webhook lane on the one job that declares it', () => {
    expect(generateE2eMatrix().match(/webhookLane: true/g)).toHaveLength(1);
    const lane = E2E_PROJECTS.find((project) => 'webhookLane' in project);
    expect(generateE2eMatrix()).toContain(
      `- project: ${lane?.name ?? ''}\n  browser: ${lane?.browser ?? ''}\n  webhookLane: true`
    );
  });
});

describe('generateE2eRunSet', () => {
  it('declares the run every job belongs to as every registered project', () => {
    expect(generateE2eRunSet()).toBe(
      `E2E_RUN_PROJECTS: '${E2E_PROJECTS.map((project) => project.name).join(',')}'\n`
    );
  });
});
