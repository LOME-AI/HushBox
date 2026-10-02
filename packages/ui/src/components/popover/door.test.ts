import { describe, it, expect } from 'vitest';
import * as door from '@hushbox/ui/popover';

describe('@hushbox/ui/popover', () => {
  it('publishes the popover, its fact line, the peek and the tooltip', () => {
    expect(Object.keys(door).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'Peek',
      'Popover',
      'PopoverFact',
      'Tooltip',
      'TooltipContent',
      'TooltipTrigger',
    ]);
  });
});
