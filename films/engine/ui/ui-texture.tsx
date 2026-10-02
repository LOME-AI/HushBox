import { useEffect, useLayoutEffect, useState } from 'react';
import { useDelayRender } from 'remotion';

interface Loaded {
  file: string;
  bitmap: ImageBitmap;
}

/**
 * The UI pass's pixels in `file` inside the render's bundle, decoded exactly as
 * written (not premultiplied, no colour conversion), holding the frame until
 * they have; null while they load and whenever `file` is null. A file the pass
 * did not write fails the render naming the look and the frame.
 */
export function useUiTexture(
  where: string,
  frame: number,
  file: string | null
): ImageBitmap | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const { delayRender, continueRender, cancelRender } = useDelayRender();

  useLayoutEffect(() => {
    if (file === null) {
      return;
    }
    const request = { current: true };
    const handle = delayRender(`Loading the UI's pixels of frame ${String(frame)}`);
    void (async (): Promise<void> => {
      try {
        const response = await fetch(`/${file}`);
        if (!response.ok) {
          throw new Error(
            `${where}: frame ${String(frame)}: the UI pass wrote no pixels at ${file} (HTTP ${String(response.status)})`
          );
        }
        const bitmap = await createImageBitmap(await response.blob(), {
          premultiplyAlpha: 'none',
          colorSpaceConversion: 'none',
        });
        if (request.current) {
          setLoaded({ file, bitmap });
        } else {
          bitmap.close();
        }
        continueRender(handle);
      } catch (error) {
        cancelRender(error);
      }
    })();
    return (): void => {
      request.current = false;
    };
  }, [where, frame, file, delayRender, continueRender, cancelRender]);

  // A frame's pixels are released once the next frame's have replaced them.
  useEffect(
    () => (): void => {
      loaded?.bitmap.close();
    },
    [loaded]
  );

  return loaded !== null && loaded.file === file ? loaded.bitmap : null;
}
