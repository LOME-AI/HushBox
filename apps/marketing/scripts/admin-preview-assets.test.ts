import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { REPO_ROOT } from './admin-preview-assets.js';

describe('the preview-copy entry point', () => {
  it('resolves the repository root the copy is relative to', () => {
    expect(existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true);
  });
});
