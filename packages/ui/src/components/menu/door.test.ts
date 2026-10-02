import { describe, it, expect } from 'vitest';
import * as door from '@hushbox/ui/menu';

describe('@hushbox/ui/menu', () => {
  it('publishes the menu and its parts', () => {
    expect(Object.keys(door).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'Menu',
      'MenuFooter',
      'MenuItem',
      'MenuLabel',
      'MenuRadioGroup',
      'MenuRadioItem',
      'MenuSeparator',
    ]);
  });
});
