import * as React from 'react';
import { geoIdentity, geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import {
  CHOROPLETH_STEP_CLASSES,
  choroplethFillClass,
  choroplethStep,
} from './choropleth-scale.js';
import { formatRate } from './format-rate.js';
import { formatVisitorCount } from './funnel-math.js';
import { chartDatumLabel } from './summed-label.js';
import type { SummedFigureLabel } from './summed-label.js';
import type { GeoIdentityTransform, GeoProjection } from 'd3-geo';
import type { Topology } from 'topojson-specification';
import type { Feature, FeatureCollection, Geometry } from 'geojson';

/** The drawing's width; its height is whatever the fitted geometry needs. */
const WIDTH = 880;

/** The box a layer with no drawable geometry still occupies, so the panel keeps its room. */
const EMPTY_HEIGHT = 360;

/**
 * A height no fit can be bound by, so the width is always what the scale is
 * chosen against and the geometry's own vertical span is what is left to read
 * off the drawing.
 */
const UNBOUND_HEIGHT = WIDTH * 4;

/**
 * The one region left out of the drawing, by the code the counts are keyed by
 * rather than by a geometry id, so the exclusion is written in the vocabulary
 * the data uses.
 *
 * Antarctica runs the whole width of a world projection at its southern edge
 * and is shaded by nothing, so fitting the projection around it spends height
 * on an ice sheet: measured on the vendored 110m world file at this width, the
 * fit is 456px tall with it and 383px without. A figure for it, if a row ever
 * carries one, is in the table beside the map, which the panel's caption says.
 */
const UNDRAWN_CODE = 'AQ';

/**
 * How much room above the pointer the readout needs before it is drawn there
 * rather than below it, in the frame's own pixels.
 */
const ROOM_ABOVE = 96;

/**
 * The widest the readout is allowed to be where the frame has room for it. In
 * rem, so it grows with the font-scaling tier as the text inside it does.
 */
const READOUT_MAX_WIDTH = '16rem';

/** How close to the viewport's own edges the readout is allowed to be drawn. */
const VIEWPORT_MARGIN = 8;

/**
 * One region's figure and where that figure stands among the others this map
 * covers. Share and rank travel with the figure rather than beside it, so the
 * readout, the region's accessible name and the table cannot be assembled from
 * different arithmetic.
 */
export interface RegionReading {
  readonly visitors: number;
  readonly overflow: boolean;
  /**
   * Of every figure this map's range counted, 0 to 1, and null where the range
   * counted nothing at all and so has no whole for a share to be taken of.
   */
  readonly share: number | null;
  readonly rank: number;
  /** How many places were ranked, so a rank is readable without the table. */
  readonly of: number;
}

interface ChoroplethProps {
  readonly topology: Topology;
  /** Which layer of the topology carries the regions to draw. */
  readonly objectName: string;
  /**
   * `naturalEarth1` projects longitude and latitude for the world file;
   * `identity` is for the US file, whose coordinates are already projected with
   * the Alaska and Hawaii insets placed, and would be distorted by projecting
   * them a second time.
   */
  readonly projection: 'naturalEarth1' | 'identity';
  readonly readings: ReadonlyMap<string, RegionReading>;
  /**
   * What a region's figure is called. Branded, so the map names its measurement
   * with the same words as the table beside it rather than with a noun of its own.
   */
  readonly countLabel: SummedFigureLabel;
  /**
   * What the share of each region's figure is a share of, from
   * {@link shareLabels}: the set is the panel's to name, because it is the
   * panel that decides which places this map covers.
   */
  readonly shareLabel: string;
  /** Translates a geometry's own id into the code the counts are keyed by. */
  readonly codeForId: (id: string) => string | null;
  readonly title: string;
  readonly onSelect?: ((code: string) => void) | undefined;
}

// geoIdentity is not a GeoProjection (it has no rotate or centre), which is why
// the return names both: geoPath accepts either, and fitSize and translate are
// the only other surfaces read off it here.
//
// The identity transform reflects nothing: the pre-projected file's y already
// grows downwards, as the screen's does, so reflecting it would stand the map
// on its head. Reflection is for a source whose y grows northwards, which this
// one is not.
function projectionFor(kind: ChoroplethProps['projection']): GeoProjection | GeoIdentityTransform {
  return kind === 'naturalEarth1' ? geoNaturalEarth1() : geoIdentity();
}

/** The region's own name, falling back to the geometry's own id. */
function nameOf(shape: Feature<Geometry, { name?: string }>, id: string): string {
  const named = shape.properties.name;
  return named === undefined || named === '' ? id : named;
}

/**
 * One geometry's identity among its siblings. The id alone is not one: the
 * world file gives three of its shapes no id at all, and each of those reads as
 * the empty string, so the reconciler would take them for one child and may
 * keep the wrong path across a render. Position is the identity every geometry
 * in a layer has, and it is stable because the layer's order comes from the
 * file.
 */
function geometryKey(id: string, index: number): string {
  return `${String(index)} ${id}`;
}

/**
 * What a share was taken against, named wherever a share is stated: the map's
 * readout, a region's accessible name, and the column head of the table beside
 * them.
 *
 * The set moves with the map — the world's countries, then one country's states
 * — so a label saying only that the figure is a share leaves its reader to
 * assume a denominator that has changed under them. One composer, because the
 * readout and the table naming the same set differently read as two sets.
 */
export interface ShareLabels {
  /** Where there is room for the whole statement: the readout and a region's name. */
  readonly full: string;
  /** A column head, which has the rows under it to say what the figures are. */
  readonly column: string;
}

export function shareLabels(setName: string): ShareLabels {
  return { full: `Share of all counted in ${setName}`, column: `Share of ${setName}` };
}

/**
 * A region's accessible name: what it is, what its figure is called, the figure,
 * and the two figures the readout puts beside it. Everything the pointer can
 * read is in here, so a keyboard or a screen reader reaches all of it without
 * hovering anything.
 */
function regionLabel(
  name: string,
  countLabel: SummedFigureLabel,
  shareLabel: string,
  reading: RegionReading | undefined
): string {
  if (reading === undefined) return `${name}: not counted`;
  const figure = formatVisitorCount(reading.visitors, reading.overflow);
  return `${chartDatumLabel(name, countLabel, figure)}. ${shareLabel}: ${formatRate(
    reading.share
  )}. Rank ${String(reading.rank)} of ${String(reading.of)}.`;
}

/** One region as the drawing holds it: its outline, its shading and its names. */
interface DrawnRegion {
  readonly key: string;
  readonly outline: string;
  readonly name: string;
  readonly code: string | null;
  readonly reading: RegionReading | undefined;
  readonly step: number | null;
  readonly label: string;
}

/** Which region the map is reading, and where in the frame to draw the readout. */
interface Readout {
  readonly region: DrawnRegion;
  readonly x: number;
  readonly y: number;
  readonly below: boolean;
  /** The frame the card is held inside, whose width bounds it both ways. */
  readonly frameWidth: number;
  /**
   * Where that frame sits down the viewport, and how tall the viewport is, so
   * the card's vertical bound can be stated in the frame's own coordinates.
   * Both are read when the card is placed: the frame is only as tall as the
   * drawing's aspect ratio makes it, so at a small viewport under a large
   * font-scaling tier the card is taller than the frame and the frame is no
   * bound at all.
   */
  readonly frameTop: number;
  readonly viewportHeight: number;
}

/**
 * Where the readout may sit, as CSS for the browser to evaluate rather than
 * numbers measured here.
 *
 * The clamp cannot be arithmetic in this file, because the card's own size is
 * the browser's to decide: it is whatever the region's name and its figures
 * wrap to at the reader's font-scaling tier. Measuring the card and correcting
 * it a paint later would draw it out of bounds first, which is the state the
 * correction is for. A percentage in `translate` resolves against the element's
 * own box, so the expressions below are clamps the browser can state and we
 * cannot.
 *
 * Across: centred on the anchor, with neither edge past the frame's, and the
 * left edge winning where a card too wide for the frame cannot satisfy both —
 * the start of every line is what a clipped card loses.
 *
 * Down: the side the anchor leaves room for, but never past either edge of the
 * viewport, and the head winning where a card too tall for the viewport cannot
 * satisfy both — the region's name and its figure are what a card cut at the
 * head loses. The frame is not the bound here, because the frame's height is
 * the drawing's aspect ratio rather than anything the card fits inside.
 */
function readoutBounds(readout: Readout | null): {
  readonly x: string;
  readonly y: string;
  readonly maxWidth: string;
} {
  // Nothing is being read, so no card is drawn and none of this is painted.
  if (readout === null) return { x: '0px', y: '0px', maxWidth: READOUT_MAX_WIDTH };
  const { x, y, frameWidth, frameTop, viewportHeight } = readout;
  const preferred = readout.below ? '0.75rem' : '-100% - 0.75rem';
  const head = VIEWPORT_MARGIN - frameTop - y;
  const foot = viewportHeight - VIEWPORT_MARGIN - frameTop - y;
  return {
    x: `max(0px, min(${String(x)}px - 50%, ${String(frameWidth)}px - 100%))`,
    y: `max(${String(head)}px, min(${preferred}, ${String(foot)}px - 100%))`,
    maxWidth: `min(${READOUT_MAX_WIDTH}, ${String(frameWidth)}px)`,
  };
}

/**
 * The hatch a region with no row is painted in, defined wherever it is painted.
 * A pattern is a document reference, so an svg painting a definition that lives
 * in another one would be a coupling the markup does not state.
 */
function NoDataHatch({ id }: Readonly<{ readonly id: string }>): React.JSX.Element {
  return (
    <defs>
      <pattern
        id={id}
        width={6}
        height={6}
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width={6} height={6} className={choroplethFillClass(null)} />
        <line x1={0} y1={0} x2={0} y2={6} className="stroke-border [stroke-width:1.2]" />
      </pattern>
    </defs>
  );
}

/**
 * The smallest and the largest figure the shading was built from, each
 * formatted with its own ceiling flag, or null where the range holds nothing.
 */
function shadedRange(readings: ReadonlyMap<string, RegionReading>): string | null {
  let range: { readonly low: RegionReading; readonly high: RegionReading } | null = null;
  for (const reading of readings.values()) {
    range =
      range === null
        ? { low: reading, high: reading }
        : {
            low: reading.visitors < range.low.visitors ? reading : range.low,
            high: reading.visitors > range.high.visitors ? reading : range.high,
          };
  }
  if (range === null) return null;
  return `${formatVisitorCount(range.low.visitors, range.low.overflow)} to ${formatVisitorCount(
    range.high.visitors,
    range.high.overflow
  )}`;
}

/**
 * What the shading means, stated on screen rather than left to be guessed: the
 * ramp against the range it was built from, and the hatch that is a place with
 * no row at all. The two are the one distinction the scale must not blur, and
 * they cannot be told apart by shade — the palest step sits at 1.07:1 against
 * the no-data surface — so the absence is drawn as a hatch and named here.
 */
function ChoroplethLegend({
  readings,
  countLabel,
  hatchId,
}: Readonly<{
  readonly readings: ReadonlyMap<string, RegionReading>;
  readonly countLabel: SummedFigureLabel;
  readonly hatchId: string;
}>): React.JSX.Element {
  const range = shadedRange(readings);
  return (
    <ul
      data-slot="choropleth-legend"
      className="text-muted-foreground mt-2 flex list-none flex-wrap items-center gap-x-4 gap-y-1 p-0 text-xs"
    >
      <li className="flex flex-wrap items-center gap-1.5">
        <span>{countLabel}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <svg className="h-2.5 w-20 shrink-0" aria-hidden="true">
            {CHOROPLETH_STEP_CLASSES.map((step, index) => (
              <rect
                key={step}
                className={step}
                x={`${String(index * 20)}%`}
                width="20%"
                height="100%"
              />
            ))}
          </svg>
          <span className="tabular-nums">{range ?? 'Nothing was counted in this range'}</span>
        </span>
      </li>
      <li className="flex items-center gap-1.5">
        <svg className="h-2.5 w-5 shrink-0" aria-hidden="true">
          <NoDataHatch id={hatchId} />
          <rect width="100%" height="100%" fill={`url(#${hatchId})`} />
        </svg>
        <span>No row: not counted, rather than counted as none</span>
      </li>
    </ul>
  );
}

/**
 * A shaded map drawn as one focusable path per region, with a readout of its
 * own rather than the browser's.
 *
 * The readout follows the pointer and anchors to the region under keyboard
 * focus; every figure in it is also in the region's accessible name and in the
 * table beside the map, so nothing here is reachable only by hovering. An SVG
 * `title` element would have been the browser's tooltip instead: its delay and
 * its styling belong to the browser, and neither is ours to set.
 *
 * Places the geometry has no polygon for (microstates, the three shapes the
 * world file gives no id, and Antarctica, which the projection leaves out)
 * appear in that table and nowhere here.
 */
export function Choropleth({
  topology,
  objectName,
  projection,
  readings,
  countLabel,
  shareLabel,
  codeForId,
  title,
  onSelect,
}: Readonly<ChoroplethProps>): React.JSX.Element {
  const hatchId = `choropleth-nodata-${React.useId().replaceAll(':', '')}`;
  const frame = React.useRef<HTMLDivElement | null>(null);
  const card = React.useRef<HTMLDivElement | null>(null);
  const [readout, setReadout] = React.useState<Readout | null>(null);
  const [dismissed, setDismissed] = React.useState<string | null>(null);

  const shapes = React.useMemo(() => {
    const layer = topology.objects[objectName];
    if (layer === undefined) return [];
    const collection = feature(topology, layer) as FeatureCollection<Geometry, { name?: string }>;
    return collection.features.filter(
      (shape) => codeForId(String(shape.id ?? '')) !== UNDRAWN_CODE
    );
  }, [topology, objectName, codeForId]);

  // The box takes its height from the drawn geometry rather than from a chosen
  // number, so the drawing never sits in a band of empty ocean. The fit is
  // given a height nothing can reach, which leaves the width binding; the
  // drawing is then lifted so its northern edge lands on zero, and its southern
  // edge is the height the box needs.
  const drawing = React.useMemo(() => {
    const collection: FeatureCollection<Geometry, { name?: string }> = {
      type: 'FeatureCollection',
      features: shapes,
    };
    const fitted = projectionFor(projection).fitSize([WIDTH, UNBOUND_HEIGHT], collection);
    const top = geoPath(fitted).bounds(collection)[0][1];
    if (!Number.isFinite(top)) return { path: geoPath(fitted), height: EMPTY_HEIGHT };
    const [x, y] = fitted.translate();
    fitted.translate([x, y - top]);
    const path = geoPath(fitted);
    const spanned = path.bounds(collection)[1][1];
    return { path, height: spanned > 0 ? Math.ceil(spanned) : EMPTY_HEIGHT };
  }, [projection, shapes]);

  const regions = React.useMemo<readonly DrawnRegion[]>(() => {
    const largest = Math.max(0, ...[...readings.values()].map((reading) => reading.visitors));
    return shapes.flatMap((shape, index) => {
      const outline = drawing.path(shape);
      if (outline === null) return [];
      const id = String(shape.id ?? '');
      const code = codeForId(id);
      const reading = code === null ? undefined : readings.get(code);
      const name = nameOf(shape, id);
      return [
        {
          key: geometryKey(id, index),
          outline,
          name,
          code,
          reading,
          step: choroplethStep(reading?.visitors, largest),
          label: regionLabel(name, countLabel, shareLabel, reading),
        },
      ];
    });
  }, [shapes, drawing, readings, codeForId, countLabel, shareLabel]);

  /** The frame's own box, or an empty one before anything has been laid out. */
  const frameBox = (): DOMRect => frame.current?.getBoundingClientRect() ?? new DOMRect();

  const reading = readout?.region.key ?? null;
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || reading === null) return;
      setDismissed(reading);
      setReadout(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [reading]);

  // WCAG 1.4.13's hoverable condition, which a card that follows the pointer
  // does not get for free: while the pointer is inside the card's own box the
  // card neither moves, changes region, nor goes, so a pointer moved across it
  // reads it instead of dismissing it. A box with no area is a card that is not
  // laid out, which nothing can be over.
  //
  // It guards the pointer's own paths and no other. Keyboard focus is not a
  // pointer: a region reached by tabbing sits under the card as often as not,
  // and a guard on that path leaves a keyboard reader with no readout at all.
  const overReadout = (clientX: number, clientY: number): boolean => {
    const box = card.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0 || box.height === 0) return false;
    return (
      clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom
    );
  };

  /**
   * Draws the readout for a region, anchored at a point in client coordinates.
   *
   * `belowAnchor` is the point the card hangs from when there is no room above
   * the anchor, and it exists for the keyboard: a card anchored to a region's
   * top and then flipped downwards is drawn over the region it names, which at
   * the world's scale hides the shape and the outline marking it focused. Given
   * the region's own bottom edge, the card that cannot sit above the region
   * sits under it instead. The pointer has no such second point — it is the
   * anchor, and a card under it hides nothing.
   */
  const show = (
    region: DrawnRegion,
    clientX: number,
    clientY: number,
    belowAnchor?: number
  ): void => {
    if (dismissed === region.key) return;
    setDismissed(null);
    const box = frameBox();
    const below = clientY - box.top < ROOM_ABOVE;
    setReadout({
      region,
      x: clientX - box.left,
      y: (below && belowAnchor !== undefined ? belowAnchor : clientY) - box.top,
      below,
      frameWidth: box.width,
      frameTop: box.top,
      viewportHeight: window.innerHeight,
    });
  };

  // A dismissal holds for exactly as long as the same region is still the one
  // being read: the escape key stands against a pointer that has not left the
  // region it dismissed, and against focus that has not moved off it. Every
  // other way out of it clears it — {@link show} reading another region, the
  // pointer leaving the map, and focus leaving the region — because a
  // dismissal outliving its own reading silences the region it names while the
  // card that replaced it stays on screen, which is a figure against the wrong
  // place.
  const leave = (): void => {
    setReadout(null);
    setDismissed(null);
  };

  const bounds = readoutBounds(readout);

  return (
    <div>
      <div ref={frame} data-slot="choropleth-frame" className="relative">
        <svg
          viewBox={`0 0 ${String(WIDTH)} ${String(drawing.height)}`}
          className="h-auto w-full"
          role="group"
          aria-label={title}
          onPointerMove={(event) => {
            if (event.target !== event.currentTarget) return;
            if (!overReadout(event.clientX, event.clientY)) leave();
          }}
          onPointerLeave={leave}
        >
          <NoDataHatch id={hatchId} />
          {regions.map((region) => {
            const select = (): void => {
              if (region.code !== null) onSelect?.(region.code);
            };
            return (
              <path
                key={region.key}
                d={region.outline}
                tabIndex={0}
                role="img"
                aria-label={region.label}
                {...(region.step === null ? { fill: `url(#${hatchId})` } : {})}
                className={`${region.step === null ? '' : choroplethFillClass(region.step)} stroke-border focus-visible:stroke-ring [stroke-width:0.5] outline-none`}
                onPointerMove={(event) => {
                  if (overReadout(event.clientX, event.clientY)) return;
                  show(region, event.clientX, event.clientY);
                }}
                onFocus={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  show(region, box.left + box.width / 2, box.top, box.bottom);
                }}
                onBlur={leave}
                onClick={select}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  select();
                }}
              />
            );
          })}
          {readout !== null && (
            // The region being read, outlined over the top of its neighbours:
            // a stroke on the region itself is painted over by every shape the
            // file lists after it.
            <path
              d={readout.region.outline}
              className="stroke-foreground pointer-events-none fill-none [stroke-width:1.6]"
            />
          )}
        </svg>
        {readout !== null && (
          // Hidden from the accessible tree, and transparent to the pointer:
          // every figure in it is in the region's own name already, and a
          // pointer that cannot land on it is a pointer that cannot dismiss it
          // by moving onto it.
          <div
            ref={card}
            data-slot="choropleth-readout"
            aria-hidden="true"
            className="border-border bg-card text-card-foreground z-popover pointer-events-none absolute left-0 w-max max-w-[var(--readout-width)] translate-x-[var(--readout-x)] translate-y-[var(--readout-y)] rounded-md border p-2 text-xs shadow-sm"
            style={{
              top: `${String(readout.y)}px`,
              ['--readout-x' as string]: bounds.x,
              ['--readout-y' as string]: bounds.y,
              ['--readout-width' as string]: bounds.maxWidth,
            }}
          >
            <p className="font-semibold">{readout.region.name}</p>
            {readout.region.reading === undefined ? (
              <p className="text-muted-foreground mt-1">
                No row was returned for this place, so it was not counted rather than counted as
                none.
              </p>
            ) : (
              <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 tabular-nums">
                <dt className="text-muted-foreground">{countLabel}</dt>
                <dd className="m-0 text-right">
                  {formatVisitorCount(
                    readout.region.reading.visitors,
                    readout.region.reading.overflow
                  )}
                </dd>
                <dt className="text-muted-foreground">{shareLabel}</dt>
                <dd className="m-0 text-right">{formatRate(readout.region.reading.share)}</dd>
                <dt className="text-muted-foreground">Rank</dt>
                <dd className="m-0 text-right">{`${String(readout.region.reading.rank)} of ${String(
                  readout.region.reading.of
                )}`}</dd>
              </dl>
            )}
          </div>
        )}
      </div>
      <ChoroplethLegend readings={readings} countLabel={countLabel} hatchId={`${hatchId}-key`} />
    </div>
  );
}
