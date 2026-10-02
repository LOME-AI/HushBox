import { describe, it, expect } from 'vitest';
import { vitestUiArgs } from './test-watch-ui.js';

describe('vitestUiArgs', () => {
  it('watches everything the config collects when the caller passes nothing', () => {
    expect(vitestUiArgs([])).toEqual(['--ui']);
  });

  it('forwards a caller’s arguments in order behind the ui flag', () => {
    expect(vitestUiArgs(['apps/web', '-t', 'renders a cost'])).toEqual([
      '--ui',
      'apps/web',
      '-t',
      'renders a cost',
    ]);
  });

  it('drops the separator pnpm keeps ahead of a caller’s arguments', () => {
    expect(vitestUiArgs(['--', 'apps/web', '-t', 'renders a cost'])).toEqual([
      '--ui',
      'apps/web',
      '-t',
      'renders a cost',
    ]);
  });

  it('refuses a separator the caller’s own arguments still carry', () => {
    // Playwright answers for a separator that survives; vitest swallows it and
    // everything behind it without a word, so passing one on would drop
    // arguments silently.
    expect(() => vitestUiArgs(['--', 'apps/web', '--', '-t', 'a name'])).toThrow(
      "test:watch:ui: `--` ends vitest's options, so `-t`, `a name` would have reached neither " +
        'a filter nor a flag and the run would have covered everything the config collects. ' +
        'Write the same arguments without the `--`.'
    );
  });
});
