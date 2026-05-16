import * as React from 'react';

type NativeImgProps = React.ImgHTMLAttributes<HTMLImageElement>;

interface ImgProps extends Omit<NativeImgProps, 'alt' | 'loading'> {
  /** Required alt text. TypeScript-enforced — pass `""` only for purely decorative images. */
  alt: string;
  /** When true, marks the image so accessibility "invert colors" mode skips re-inverting it. */
  decorative?: boolean;
  /** Override the default `loading="lazy"`. */
  loading?: NativeImgProps['loading'];
}

function Img({
  alt,
  decorative,
  loading = 'lazy',
  ...rest
}: Readonly<ImgProps>): React.JSX.Element {
  return (
    // eslint-disable-next-line no-restricted-syntax -- Img IS the wrapper that the lint rule directs other code to use; must render the raw <img> internally
    <img
      alt={alt}
      loading={loading}
      {...(decorative === true ? { 'data-no-invert': '' } : {})}
      {...rest}
    />
  );
}

export { Img, type ImgProps };
