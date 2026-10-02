import { describe, it, expect } from 'vitest';
import * as door from '@hushbox/ui/overlay';

describe('@hushbox/ui/overlay', () => {
  it('publishes the overlay, its presentation hook and the dialog grammar', () => {
    expect(Object.keys(door).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'Overlay',
      'OverlayBody',
      'OverlayContent',
      'OverlayFooter',
      'OverlayHeader',
      'OverlayTitle',
      'useOverlayFocusReturn',
      'useOverlayPresentation',
    ]);
  });
});
