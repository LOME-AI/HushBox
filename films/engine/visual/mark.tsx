import { Img } from 'remotion';

import logo from '@hushbox/ui/assets/HushBoxLogo.png';

import type { CSSProperties } from 'react';

interface MarkProps {
  /** The mark's width in pixels; its height follows the logo's own proportions. */
  size: number;
  /** Placement and effects; the size wins over any width or height set here. */
  style?: CSSProperties;
}

/** The HushBox mark, from the brand's own logo file. */
export function Mark({ size, style }: Readonly<MarkProps>): React.JSX.Element {
  return (
    <Img
      src={logo}
      alt="HushBox"
      style={{ display: 'block', ...style, width: size, height: 'auto' }}
    />
  );
}
