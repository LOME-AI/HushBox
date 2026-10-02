import { describe, it, expect } from 'vitest';
import * as door from '@hushbox/ui/button';

describe('@hushbox/ui/button', () => {
  it('publishes the button, the icon button, the spinner, the class recipe and the button groups', () => {
    expect(Object.keys(door).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'Button',
      'ButtonRow',
      'ButtonStack',
      'buttonVariants',
      'IconButton',
      'Spinner',
    ]);
  });
});
