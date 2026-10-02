import { useIsMobile } from '../../hooks/use-is-mobile';
import { useIsTouchDevice } from '../../hooks/use-is-touch-device';

import type { LAYOUT } from '@hushbox/shared/design-tokens';

export interface FormFactor {
  // The token module names the two bands only as its per-band gutter keys.
  readonly band: keyof typeof LAYOUT.gutter;
  readonly pointer: 'fine' | 'coarse';
}

/** The viewport band and primary pointer, for behaviour only; layout reads the same band in CSS. */
export function useFormFactor(): FormFactor {
  const isPhone = useIsMobile();
  const isCoarse = useIsTouchDevice();
  return { band: isPhone ? 'phone' : 'desktop', pointer: isCoarse ? 'coarse' : 'fine' };
}
