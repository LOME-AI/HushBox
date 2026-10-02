import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// No DOM harness renders `.astro` files in this app, so the gate is asserted
// against the component source (mirrors ThemeScript.astro.test.ts). What the
// badge does once mounted is pinned where it lives, by the packages/ui suite.
const source = readFileSync(path.resolve(__dirname, './CrawlerEye.astro'), 'utf8');
const gate = source.split('\n').find((line) => line.startsWith('const gateOn'));

describe('CrawlerEye gate', () => {
  it('reads the shared env utility rather than branching on an env variable directly', () => {
    expect(gate).toContain('env.isDevServer');
    expect(gate).not.toMatch(/import\.meta\.env/);
  });
});
