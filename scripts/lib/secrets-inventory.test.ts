import { describe, it, expect } from 'vitest';

import { inventoryTable } from './secrets-inventory.js';
import type { Credential } from '../../packages/shared/src/env/env-types.js';

/** Where the secrets document sits, which each row's runbook link is relative to. */
const DOCUMENT = 'docs/SECRETS.md';

/** The table's lines as trimmed cells; an escaped pipe stays inside its cell. */
const cellsOf = (block: string): string[][] =>
  block
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((cell) => cell.trim())
    );

const alone: Credential = {
  description: 'Signs the thing | twice.',
  store: 'github:ci',
  replace: 'transparent',
  onLoss: 'reissueAtVendor',
  family: 'random-secret',
  userVisible: 'none',
  leakImpact: 'nuisance',
};
const coupled: Credential = { ...alone, coupledWith: ['B_KEY', 'C_KEY'] };

describe('the secrets inventory table', () => {
  it('heads the table with one column per declared field', () => {
    const [header, rule] = cellsOf(inventoryTable([['A_KEY', alone]], DOCUMENT));

    expect(header).toEqual([
      'Name',
      'Family',
      'Store',
      'Description',
      'Replace',
      'On loss',
      'Escrowed',
      'User-visible',
      'Coupled with',
      'Leak impact',
    ]);
    expect(rule?.every((cell) => /^-+$/.test(cell))).toBe(true);
  });

  it('renders each declared field in its column', () => {
    const row = cellsOf(inventoryTable([['A_KEY', coupled]], DOCUMENT))[2];

    expect(row).toEqual([
      '`A_KEY`',
      '[random-secret](runbooks/secrets/random-secret.md)',
      'github:ci',
      String.raw`Signs the thing \| twice.`,
      'transparent',
      'reissueAtVendor',
      '',
      'none',
      '`B_KEY`, `C_KEY`',
      'nuisance',
    ]);
  });

  it('leaves the coupling column empty for a declaration coupled with nothing', () => {
    const row = cellsOf(inventoryTable([['A_KEY', alone]], DOCUMENT))[2];

    expect(row?.[8]).toBe('');
  });

  it('marks a declaration the escrow captures', () => {
    const escrowed: Credential = { ...alone, onLoss: 'restoreFromCopy' };
    const row = cellsOf(inventoryTable([['A_KEY', escrowed]], DOCUMENT))[2];

    expect(row?.[6]).toBe('yes');
  });

  it('leaves the escrow column empty for a declaration of another loss class', () => {
    const row = cellsOf(inventoryTable([['A_KEY', alone]], DOCUMENT))[2];

    expect(row?.[6]).toBe('');
  });
});
