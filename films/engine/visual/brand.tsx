import '@hushbox/config/tailwind';
import '@hushbox/ui/fonts';

import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import { AbsoluteFill, useDelayRender } from 'remotion';

import { readBrandColors } from './brand-tokens.js';

import type { ReactNode } from 'react';
import type { BrandColors } from './brand-tokens.js';

interface Brand {
  colors: BrandColors;
}

const BrandContext = createContext<Brand | null>(null);

function useBrandContext(): Brand {
  const brand = useContext(BrandContext);
  if (brand === null) {
    throw new Error('brand values are read inside <BrandRoot>, and this component sits outside it');
  }
  return brand;
}

interface BrandRootProps {
  children: ReactNode;
}

/**
 * The brand's dark scope over the whole frame: the brand stylesheet and font
 * faces, the warm charcoal field, and the brand colours read from the
 * stylesheet for {@link useBrand}. Children render once the colours are read.
 */
export function BrandRoot({ children }: Readonly<BrandRootProps>): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [brand, setBrand] = useState<Brand | null>(null);
  const { cancelRender } = useDelayRender();

  useLayoutEffect(() => {
    if (root.current === null) {
      return;
    }
    try {
      setBrand({ colors: readBrandColors(getComputedStyle(root.current)) });
    } catch (error) {
      cancelRender(error);
    }
  }, [cancelRender]);

  return (
    <AbsoluteFill
      ref={root}
      className="dark"
      style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}
    >
      {brand === null ? null : <BrandContext value={brand}>{children}</BrandContext>}
    </AbsoluteFill>
  );
}

/** The brand colours `BrandRoot` read from the brand stylesheet's dark theme. */
export function useBrand(): BrandColors {
  return useBrandContext().colors;
}
