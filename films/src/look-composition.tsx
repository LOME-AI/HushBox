import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AbsoluteFill,
  Html5Audio,
  staticFile,
  useCurrentFrame,
  useDelayRender,
  useVideoConfig,
} from 'remotion';

import { readQa } from '../engine/layout/claims.js';
import {
  canvasLayer,
  createLookPainter,
  createTextCollector,
  loadLookFonts,
  loadLookLogo,
  lookRandom,
  lookTextLine,
  textBoxesOf,
  uiPlacementOf,
} from '../engine/look/index.js';
import { readQaHideText, readQaSkipPost } from '../engine/qa/qa-props.js';
import { FPS, HEIGHT, WIDTH } from '../engine/time/grid.js';
import { UiLayer } from '../engine/ui/ui-layer.js';
import { textureFrames, uiFrameFile, uiPlanLine } from '../engine/ui/ui-plan.js';
import { readUiProps } from '../engine/ui/ui-props.js';
import { useUiTexture } from '../engine/ui/ui-texture.js';
import { BrandRoot, useBrand } from '../engine/visual/brand.js';
import { GlCanvas, GlMarker, PostChain } from '../engine/visual/gl/index.js';

import type { ComponentType, CSSProperties } from 'react';
import type {
  LoadedLook,
  LookLogo,
  OpenFamily,
  UiContext,
  UiPlacement,
  UiProps,
} from '../engine/look/index.js';
import type { UiRequest } from '../engine/ui/ui-props.js';
import type { GlRegistration } from '../engine/visual/gl/index.js';

/** The open-licence fonts the bundle carries, for every look. */
export interface LookFonts {
  families: readonly OpenFamily[];
  /** The URL a font file, relative to the fonts directory, is served at. */
  urlOf: (file: string) => string;
}

/** A film or take drawn by a look module. */
export interface LookFilm {
  /** The directory holding the look, named in every failure. */
  where: string;
  /** The spec's seed, which keys the look's random source. */
  seed: string;
  look: LoadedLook;
  /** The master the Studio preview plays, under the public directory; none for a take. */
  audio: string | null;
  fonts: LookFonts;
}

interface LookLayerProps {
  paintAt: (time: number) => HTMLCanvasElement;
  samples: number;
}

/**
 * The look as the canvas's one required layer. Under motion blur the canvas
 * renders this again at each sub-frame instant, where the frame it reads is
 * that instant.
 */
function LookLayer({ paintAt, samples }: Readonly<LookLayerProps>): React.JSX.Element {
  const time = useCurrentFrame();
  const registration = useMemo(
    (): GlRegistration => ({
      kind: 'layers',
      layers: [canvasLayer({ id: 'look', samples, paint: () => paintAt(time) })],
    }),
    [paintAt, samples, time]
  );
  return <GlMarker registration={registration} />;
}

/** Loads every font a look can set type in, holding the frame until all have loaded. */
function useLookFonts(
  root: React.RefObject<HTMLDivElement | null>,
  { families, urlOf }: LookFonts
): Record<string, string> | null {
  const [fonts, setFonts] = useState<Record<string, string> | null>(null);
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [handle] = useState(() => delayRender('Loading the look fonts'));

  useLayoutEffect(() => {
    if (root.current === null) {
      return;
    }
    const style = getComputedStyle(root.current);
    void (async (): Promise<void> => {
      try {
        setFonts(
          await loadLookFonts({
            style,
            families,
            urlOf,
            faces: document.fonts,
            createFace: (family, source, weight, faceStyle) =>
              new FontFace(family, source, { weight, style: faceStyle }),
          })
        );
        continueRender(handle);
      } catch (error) {
        cancelRender(error);
      }
    })();
  }, [root, families, urlOf, handle, continueRender, cancelRender]);

  return fonts;
}

/** Decodes the brand logo and traces its mark, holding the frame until both are done. */
function useLookLogo(): LookLogo | null {
  const [logo, setLogo] = useState<LookLogo | null>(null);
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [handle] = useState(() => delayRender('Loading the brand logo'));

  useLayoutEffect(() => {
    void (async (): Promise<void> => {
      try {
        setLogo(await loadLookLogo());
        continueRender(handle);
      } catch (error) {
        cancelRender(error);
      }
    })();
  }, [handle, continueRender, cancelRender]);

  return logo;
}

interface LookPictureProps {
  film: LookFilm;
  fonts: Readonly<Record<string, string>>;
  logo: LookLogo;
  hideText: boolean;
  /** Presents the look's own pixels, the post chain skipped: the containment pair. */
  skipPost: boolean;
  qa: boolean;
  /** Where the UI pass wrote the UI's pixels, or null when none ran. */
  uiFrames: string | null;
}

/** The layer's place among the canvases on a frame: the look's own canvas, the UI, the front canvas. */
function uiLayerStyle(placement: UiPlacement): CSSProperties {
  const shown = placement === 'behind' || placement === 'front';
  return { zIndex: placement === 'front' ? 2 : 1, visibility: shown ? 'visible' : 'hidden' };
}

/** The UI context: what `renderFrame` gets beside its canvases, less the per-call instant and text flag. */
function useUiContext(random: UiContext['random'], fonts: UiContext['fonts']): UiContext {
  const brand = useBrand();
  return useMemo(
    (): UiContext => ({ width: WIDTH, height: HEIGHT, fps: FPS, random, brand, fonts }),
    [random, brand, fonts]
  );
}

/** Where the painter's front canvas joins the page, over the UI layer unless the look puts the UI in front. */
function FrontCanvas({ canvas }: Readonly<{ canvas: HTMLCanvasElement }>): React.JSX.Element {
  const holder = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = holder.current;
    if (element === null) {
      return;
    }
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    element.append(canvas);
    return (): void => {
      canvas.remove();
    };
  }, [canvas]);
  return <AbsoluteFill ref={holder} style={{ zIndex: 1 }} />;
}

/** A look's UI layer on the current frame: its component and where it sits. */
interface UiFrame {
  Ui: ComponentType<UiProps>;
  placement: UiPlacement;
}

/**
 * The look's UI layer on the current frame, or null for a look without one,
 * and on a texture frame the UI's pixels, null until they have loaded. A
 * texture frame rendered with no UI pass, as Studio renders, fails naming the
 * look and the frame.
 */
function useUiFrame(
  { where, look }: LookFilm,
  frame: number,
  uiFrames: string | null
): { layer: UiFrame | null; ui: ImageBitmap | null } {
  const layer =
    look.Ui === undefined || look.placeUi === undefined
      ? null
      : { Ui: look.Ui, placement: uiPlacementOf(where, frame, look.placeUi(frame)) };
  const textured = layer?.placement === 'texture';
  const ui = useUiTexture(
    where,
    frame,
    textured && uiFrames !== null ? uiFrameFile(uiFrames, frame) : null
  );
  if (textured && uiFrames === null) {
    throw new Error(
      `${where}: frame ${String(frame)} places its UI as a texture, whose pixels only a render through the films CLI supplies`
    );
  }
  return { layer, ui };
}

interface UiStackProps {
  layer: UiFrame;
  front: HTMLCanvasElement;
  frame: number;
  ctx: UiContext;
}

/** The UI layer over the look's canvas, and the front canvas over or under it as the frame places it. */
function UiStack({ layer, front, frame, ctx }: Readonly<UiStackProps>): React.JSX.Element {
  return (
    <>
      <UiLayer Ui={layer.Ui} frame={frame} ctx={ctx} style={uiLayerStyle(layer.placement)} />
      <FrontCanvas canvas={front} />
    </>
  );
}

/**
 * The look drawn through the GPU canvas: `renderFrame` once per frame, or once
 * per sub-frame when the look opts into motion blur, then the post chain when
 * it opts into that. Every call's text boxes are checked, and with the QA
 * channel on each frame's text is written to the console as one line. A look
 * with a UI layer has it drawn over the canvas, with the front canvas, which
 * the call at the frame's own instant draws, over or under it.
 */
function LookPicture({
  film,
  fonts,
  logo,
  hideText,
  skipPost,
  qa,
  uiFrames,
}: Readonly<LookPictureProps>): React.JSX.Element {
  const { where, seed, look } = film;
  const frame = useCurrentFrame();
  const brand = useBrand();
  const samples = look.motionBlur ?? 1;
  const { layer, ui } = useUiFrame(film, frame, uiFrames);
  const [painter] = useState(() => createLookPainter(where, look));
  const [random] = useState(() => lookRandom(seed));
  const [collector] = useState(() =>
    createTextCollector({
      where,
      samples,
      onFrame: (drawn, boxes) => {
        if (qa) {
          console.warn(lookTextLine(drawn, boxes));
        }
      },
    })
  );

  const paintAt = useCallback(
    (time: number): HTMLCanvasElement => {
      const returned = painter.paint(
        frame,
        { width: WIDTH, height: HEIGHT, fps: FPS, time, random, brand, fonts, logo, hideText, ui },
        time === frame
      );
      collector.add(frame, textBoxesOf(where, frame, returned));
      return painter.canvas;
    },
    [painter, frame, random, brand, fonts, logo, hideText, ui, collector, where]
  );
  const uiContext = useUiContext(random, fonts);

  // On a texture frame the look draws only once the UI's pixels have loaded.
  const waiting = layer?.placement === 'texture' && ui === null;
  const canvas = (
    <GlCanvas>
      {waiting ? null : <LookLayer paintAt={paintAt} samples={samples} />}
      {look.post === undefined || skipPost ? null : <PostChain {...look.post(frame)} />}
    </GlCanvas>
  );
  if (layer === null || painter.front === null) {
    return canvas;
  }
  return (
    <>
      {canvas}
      <UiStack layer={layer} front={painter.front} frame={frame} ctx={uiContext} />
    </>
  );
}

/** The UI pass's picture: the look's UI layer alone, shown on nothing, whatever the frame's placement. */
function UiPassPicture({
  film,
  fonts,
}: Readonly<{ film: LookFilm; fonts: Readonly<Record<string, string>> }>): React.JSX.Element {
  const frame = useCurrentFrame();
  const [random] = useState(() => lookRandom(film.seed));
  const uiContext = useUiContext(random, fonts);
  const { Ui } = film.look;
  if (Ui === undefined) {
    throw new Error(`${film.where}: the UI pass ran on a look with no UI layer`);
  }
  return <UiLayer Ui={Ui} frame={frame} ctx={uiContext} style={{ visibility: 'visible' }} />;
}

/**
 * The plan probe: reports, on one console line, every frame the look places its
 * UI as a texture, which the renderer draws in a UI pass before the picture.
 */
function UiPlanProbe({ film }: Readonly<{ film: LookFilm }>): React.JSX.Element {
  const { durationInFrames } = useVideoConfig();
  const { where, look } = film;
  const [line] = useState(() =>
    uiPlanLine(
      look.placeUi === undefined ? [] : textureFrames(where, durationInFrames, look.placeUi)
    )
  );
  useLayoutEffect(() => {
    console.warn(line);
  }, [line]);
  return <AbsoluteFill />;
}

interface LookStageProps {
  film: LookFilm;
  hideText: boolean;
  skipPost: boolean;
  qa: boolean;
  ui: UiRequest;
}

/**
 * Holds the frame until the look's fonts and the brand logo have loaded, then
 * draws the picture, or in the UI pass the UI alone.
 */
function LookStage({
  film,
  hideText,
  skipPost,
  qa,
  ui,
}: Readonly<LookStageProps>): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const fonts = useLookFonts(root, film.fonts);
  const logo = useLookLogo();
  let picture: React.JSX.Element | null = null;
  if (fonts !== null && logo !== null) {
    picture = ui.pass ? (
      <UiPassPicture film={film} fonts={fonts} />
    ) : (
      <LookPicture
        film={film}
        fonts={fonts}
        logo={logo}
        hideText={hideText}
        skipPost={skipPost}
        qa={qa}
        uiFrames={ui.frames}
      />
    );
  }
  return <AbsoluteFill ref={root}>{picture}</AbsoluteFill>;
}

/** The one composition every film and take with a look module renders through. */
export function lookComposition(
  film: LookFilm
): (props: Record<string, unknown>) => React.JSX.Element {
  return function LookComposition(props) {
    const ui = readUiProps(props);
    if (ui.plan) {
      return <UiPlanProbe film={film} />;
    }
    const picture = (
      <BrandRoot>
        {film.audio === null ? null : <Html5Audio src={staticFile(film.audio)} />}
        <LookStage
          film={film}
          hideText={readQaHideText(props)}
          skipPost={readQaSkipPost(props)}
          qa={readQa(props)}
          ui={ui}
        />
      </BrandRoot>
    );
    // The UI pass hides the brand's field and every canvas, and the UI layer shows itself.
    return ui.pass ? (
      <AbsoluteFill style={{ visibility: 'hidden' }}>{picture}</AbsoluteFill>
    ) : (
      picture
    );
  };
}
