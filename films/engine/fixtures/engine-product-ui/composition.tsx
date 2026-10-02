import { useState } from 'react';
import { AbsoluteFill, Sequence, getInputProps, staticFile, useCurrentFrame } from 'remotion';
import { z } from 'zod';

import { Button, Img, Logo } from '@hushbox/ui';

import { BrandRoot, logZoom } from '../../visual/index.js';
import { ProductFrame } from '../../visual/product-frame.js';
import { definition } from './film.js';

/**
 * Studio reaches every composition through the bundler context in the package
 * root, so no module imports these exports.
 * @toolContract
 */
export { definition } from './film.js';

/** Probes of `ProductFrame`'s holds; with none set the frame shows only the Logo and the Button. */
const probesSchema = z.object({
  /**
   * An image mounts from frame 1 inside a second frame above the product:
   * `valid` is a Logo, `broken` an `Img` whose source does not exist, which fails the render.
   */
  lateImage: z.enum(['valid', 'broken']).optional(),
  /** The Button's label is set in a family no font face declares, which fails the render. */
  undeclaredFace: z.boolean().optional(),
});

type Probes = z.infer<typeof probesSchema>;

const LATE_FROM = 1;
// No such file exists in the public directory.
const MISSING_IMAGE = 'missing-product-image.png';
const LATE_SCALE = 3;
const LATE_TOP_PX = 320;
const UNDECLARED_FAMILY = 'Undeclared Face';
const SCALE_FROM = 3.25;
const SCALE_TO = 3.5;

/**
 * A second frame at a constant scale whose parent never re-renders, so only
 * `ProductFrame`'s own frame subscription can hold for the image that mounts in it.
 */
function LateImageProbe({
  lateImage,
}: Readonly<{ lateImage: 'valid' | 'broken' }>): React.JSX.Element {
  return (
    <AbsoluteFill style={{ alignItems: 'center', paddingTop: LATE_TOP_PX }}>
      <ProductFrame scale={LATE_SCALE}>
        <Sequence from={LATE_FROM} layout="none">
          {lateImage === 'valid' ? <Logo /> : <Img src={staticFile(MISSING_IMAGE)} alt="" />}
        </Sequence>
      </ProductFrame>
    </AbsoluteFill>
  );
}

function Product({ undeclaredFace }: Readonly<Pick<Probes, 'undeclaredFace'>>): React.JSX.Element {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <ProductFrame
        scale={logZoom(frame, 0, definition.spec.durationInFrames, [SCALE_FROM, SCALE_TO])}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32 }}
      >
        <Logo />
        <Button style={undeclaredFace === true ? { fontFamily: UNDECLARED_FAMILY } : undefined}>
          Start a private chat
        </Button>
      </ProductFrame>
    </AbsoluteFill>
  );
}

/**
 * The frame Studio renders for this fixture. It sets no type of its own:
 * `ProductFrame` holds for the faces the product draws.
 * @toolContract
 */
export function Component(): React.JSX.Element {
  const [probes] = useState(() => probesSchema.parse(getInputProps()));
  return (
    <BrandRoot>
      <Product undeclaredFace={probes.undeclaredFace} />
      {probes.lateImage === undefined ? null : <LateImageProbe lateImage={probes.lateImage} />}
    </BrandRoot>
  );
}
