import { ExternalLink } from 'lucide-react';
import * as React from 'react';

import { adminPreviewPath, GROWTH_CLICK_SELECTOR, MARKETING_ROUTES } from '@hushbox/shared';
import { cn, ScrollRegion, ToggleGroup, ToggleGroupItem } from '@hushbox/ui';
import { SelectField } from '@hushbox/ui/field';
import { readThemeColor } from '@hushbox/ui/cipher-wall/hook';
import { useRootTheme } from '@hushbox/ui/root-theme';

// The ramp's own background utilities, imported rather than written out again:
// a third copy of the five class names would be free to drift from the two the
// map and the cohort grid already share.
import { COHORT_STEP_CLASSES } from './choropleth-scale.js';
import { heatFields, heatRange, paintHeat, railBands, SEQUENTIAL_TOKENS } from './click-heat.js';

import {
  BADGE_HEIGHT,
  badgePlacement,
  badgeSize,
  fitScale,
  frameRoom,
  GROUP_BORDER,
  groupWidth,
  inFixedViewport,
  isMeasurable,
  overlayBadge,
  RAIL_WIDTH,
} from './click-overlay-boxes.js';
import { formatVisitorCount } from './funnel-math.js';

import type { HeatField, HeatSource } from './click-heat.js';
import type { BadgePlacement, OverlayPage, OverlaySize } from './click-overlay-boxes.js';
import type { EventTotal } from './events-panel.js';

/** The pages the frame can show, each offered under its own route. */
const PAGE_OPTIONS: readonly { value: string; label: React.ReactNode }[] = MARKETING_ROUTES.map(
  (route) => ({ value: route, label: <span className="font-mono">{route}</span> })
);

/** The device widths the frame stands for, widest first. */
const DEVICES = [
  { width: 1280, label: 'Desktop' },
  { width: 768, label: 'Tablet' },
  { width: 390, label: 'Phone' },
] as const;

/** Which of the three things the overlay draws over the framed page. */
const VIEWS = [
  { value: 'both', label: 'Heat and counts' },
  { value: 'heat', label: 'Heat' },
  { value: 'counts', label: 'Counts' },
] as const;

type OverlayView = (typeof VIEWS)[number]['value'];

/**
 * How many slices of the page the rail bands. Enough that a band is a part of
 * the page rather than a screen of it, few enough that each stays a readable
 * block at the rail's width.
 */
const RAIL_BANDS = 14;

/** The smallest share of the rail the knob is drawn at, so it stays visible on a long page. */
const MIN_KNOB_SHARE = 0.06;

/** The control row's own type size and density, which the two segmented groups take. */
const TOGGLE_ITEM_CLASS = 'px-2 text-xs';

/** What a badge's own figure makes it: the page's busiest, a count, or a nought. */
type BadgeTone = 'most' | 'counted' | 'none';

/**
 * How each of the three reads. The brand red is spent on the page's busiest
 * element and on nothing else, which is what keeps a framed page from carrying
 * a scatter of red chips (`docs/DESIGN.md` §2, the One Red Rule); a nought is
 * an outline rather than a fill, because a filled chip reads as a quantity.
 */
const BADGE_TONE_CLASSES: Record<BadgeTone, string> = {
  most: 'bg-primary text-primary-foreground font-semibold',
  counted: 'bg-foreground text-background',
  none: 'bg-background text-muted-foreground border-border-strong border border-dashed',
};

/** One badge, ready to draw over the framed page. */
interface PlacedBadge {
  readonly eventName: string;
  readonly label: string;
  readonly width: number;
  readonly placement: BadgePlacement;
  /** What the read counted, which decides whether the badge is drawn at all. */
  readonly visitors: number;
  /**
   * Whether the framed page holds this element against the frame's viewport
   * rather than its document, in which case the badge does not move when the
   * framed page scrolls.
   */
  readonly fixed: boolean;
}

/** What one reading of the framed page produced. */
interface FrameReading {
  readonly badges: readonly PlacedBadge[];
  /** Every counted element's box and figure, which the heat is drawn from. */
  readonly sources: readonly HeatSource[];
  /** The framed page's own extent, which the badges are positioned inside. */
  readonly content: OverlaySize;
  /**
   * The framed page's own root, which the heat's colours are resolved against.
   * The framed copy carries the same tokens as this screen and is in whichever
   * theme its root's class names, so the ramp the field is painted in has to be
   * the one the page under it is in: a field ranked on this screen's ramp and
   * drawn on a page in the other theme runs its weight backwards, the busiest
   * element taking the faintest mark.
   */
  readonly root: HTMLElement | null;
}

/** What the overlay draws before it has read a framed page. */
const NOTHING_READ: FrameReading = {
  badges: [],
  sources: [],
  content: { width: 0, height: 0 },
  root: null,
};

/**
 * Every badge `frameDocument` earns, each in the coordinates of whatever the
 * framed page positions its own element against.
 *
 * An element the page lays out in its document is measured relative to the
 * document element rather than to the viewport, so a page read while it is
 * scrolled is measured the same as one read at its top. An element inside a
 * fixed ancestor is measured relative to the viewport instead and brought
 * inside it, because it stays where it is while the document scrolls under it:
 * the site's landing header is fixed, and it carries most of the page's links.
 */
function readFrame({
  frameDocument,
  frameWindow,
  page,
  totals,
  viewport,
}: Readonly<{
  readonly frameDocument: Document;
  readonly frameWindow: Window;
  readonly page: OverlayPage;
  readonly totals: readonly EventTotal[];
  /** The frame's own viewport, which a pinned element's badge is placed inside. */
  readonly viewport: OverlaySize;
}>): FrameReading {
  const root = frameDocument.documentElement;
  const origin = root.getBoundingClientRect();
  const content = { width: root.scrollWidth, height: root.scrollHeight };
  const sources: HeatSource[] = [];
  const badges = [...frameDocument.querySelectorAll(GROWTH_CLICK_SELECTOR)].flatMap((element) => {
    const badge = overlayBadge(element, page, totals);
    if (badge === null) return [];
    const box = element.getBoundingClientRect();
    const fixed = inFixedViewport(element, frameWindow);
    const rect = {
      left: fixed ? box.left : box.left - origin.left,
      top: fixed ? box.top : box.top - origin.top,
      width: box.width,
      height: box.height,
    };
    if (!isMeasurable(rect)) return [];
    sources.push({ rect, visitors: badge.visitors, pinned: fixed });
    const label = formatVisitorCount(badge.visitors, badge.overflow);
    const size = badgeSize(label);
    return [
      {
        eventName: badge.eventName,
        label,
        width: size.width,
        placement: badgePlacement(rect, size, fixed ? viewport : content),
        visitors: badge.visitors,
        fixed,
      },
    ];
  });
  return { badges, sources, content, root };
}

/** What `badge` is against the busiest figure on the page. */
function toneOf(badge: PlacedBadge, most: number): BadgeTone {
  if (badge.visitors === 0) return 'none';
  return badge.visitors === most ? 'most' : 'counted';
}

/** Which badges a view draws: all of them, only the counted ones, or none. */
function badgesFor(badges: readonly PlacedBadge[], view: OverlayView): readonly PlacedBadge[] {
  if (view === 'heat') return [];
  if (view === 'counts') return badges;
  // The heat already says nothing happened where nothing happened, and a page's
  // worth of noughts beside it is what makes the panel unreadable; the Counts
  // view is where every figure, zero included, is on screen.
  return badges.filter((badge) => badge.visitors > 0);
}

/**
 * Keeps `canvas` painted with `fields`, in the ramp `scope` resolves now, and
 * says whether the canvas the panel asked for was one the browser would draw.
 *
 * A canvas paints outside the cascade, so a theme change reaches it only by
 * being watched for: the observer is on the class of the very element the
 * colours are resolved against, which is what the theme and the accessibility
 * tiers switch. One hook for both of the overlay's canvases, because they
 * differ in what they hold and in which layer they sit, in nothing about
 * painting.
 */
function usePaintedHeat(
  canvas: React.RefObject<HTMLCanvasElement | null>,
  fields: readonly HeatField[],
  scope: HTMLElement | null,
  height: number
): boolean {
  // The height a paint was refused at, rather than a bare flag: a refusal
  // belongs to the size that caused it, so a page of another height is tried
  // afresh and the refusal cannot outlive its own cause.
  const [refusedAt, setRefusedAt] = React.useState<number | null>(null);
  React.useEffect(() => {
    const element = canvas.current;
    // Read-back declared up front, because every paint ends by reading one
    // pixel to establish the canvas took it: a context not told so is put on
    // the GPU, where each read is a stall the browser warns about in as many
    // words. The fields are small gradient fills, so what a CPU-backed canvas
    // costs here is the clear, not the drawing.
    const context = element?.getContext('2d', { willReadFrequently: true }) ?? null;
    if (element === null || context === null || scope === null) return;
    const repaint = (): void => {
      const landed = paintHeat(
        context,
        { width: element.width, height: element.height },
        fields,
        SEQUENTIAL_TOKENS.map((token) => readThemeColor(token, scope))
      );
      setRefusedAt(landed ? null : element.height);
    };
    repaint();
    const observer = new MutationObserver(repaint);
    observer.observe(scope, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
    };
    // `refusedAt` is a dependency so that the refusal takes the canvas off the
    // page and this observer off the element it was watching, in one step.
  }, [canvas, fields, refusedAt, scope]);
  return refusedAt === height;
}

/**
 * Keeps the page inside `frame` in the theme this screen is in, on every load
 * and on every switch. The frame runs none of the page's scripts, so the theme
 * bootstrap the page carries never resolves one for it; the parent writes the
 * same root class that bootstrap would have.
 */
function useFramedTheme(frame: React.RefObject<HTMLIFrameElement | null>, loads: number): void {
  const theme = useRootTheme();
  React.useEffect(() => {
    const frameRoot = frame.current?.contentDocument?.documentElement ?? null;
    /* v8 ignore next -- the frame is rendered unconditionally and same-origin. */
    if (frameRoot === null) return;
    frameRoot.classList.toggle('dark', theme === 'dark');
  }, [frame, loads, theme]);
}

/**
 * The marketing page as a visitor sees it, with every link and button carrying the
 * visitor count recorded against the name a click on it is counted under.
 *
 * The copy it frames is the admin origin's own, so the parent can read the
 * frame's DOM; the site's own headers refuse framing and the public site is a
 * different origin. Being same-origin is also why the frame is sandboxed with
 * no permission to run script: a script on the copy would act with the
 * operator's authority on this origin, and the overlay reads only the built
 * markup and its geometry, which need none. Names come from the shared
 * derivation the marketing script and the build's name extractor run, against
 * this very markup, so a badge states a series the beacon wrote rather than one
 * a separate list claims.
 *
 * The frame is a device viewport and nothing else: its width is the device the
 * operator picked and its height is the room the panel holds, taken back up
 * through the fit scale. Neither is read from the page inside it, which is the
 * whole of why the panel has a bounded height. Reading the frame's height from
 * the framed content cannot be made to work, because the two define each other:
 * the site's hero sizes itself to the frame's viewport, so a frame sized from
 * its content grows its own content, and every measurement enlarges the next.
 *
 * Counts are whatever `totals` holds — the caller decides which window and
 * which page of event rows those cover, exactly as the panel beside it does.
 */
export function ClickOverlay({
  page,
  totals,
}: Readonly<{
  readonly page: OverlayPage;
  readonly totals: readonly EventTotal[];
}>): React.JSX.Element {
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const layerRef = React.useRef<HTMLDivElement>(null);
  const heatRef = React.useRef<HTMLCanvasElement>(null);
  const pinnedHeatRef = React.useRef<HTMLCanvasElement>(null);
  const knobRef = React.useRef<HTMLDivElement>(null);

  const [path, setPath] = React.useState(page.path);
  const [device, setDevice] = React.useState<number>(DEVICES[0].width);
  const [view, setView] = React.useState<OverlayView>('both');
  const [room, setRoom] = React.useState<OverlaySize>({ width: 0, height: 0 });
  const [reading, setReading] = React.useState<FrameReading>(NOTHING_READ);
  const [loads, setLoads] = React.useState(0);

  useFramedTheme(frameRef, loads);

  // The page being framed is one of the site's own static pages, with the
  // prefix the copy is served under kept from the caller: the frame has to ask
  // this origin for a page the preview build actually carries.
  const framedPage = React.useMemo<OverlayPage>(
    () => ({ basePath: page.basePath, path }),
    [page.basePath, path]
  );

  const scale = fitScale(room.width, device);
  const framedWidth = device * scale;
  const frameHeight = room.height / scale;

  /**
   * What the rail's knob is a fraction of, held outside React's state because
   * the scroll handler reads it on every event and a layout read there would
   * make the frame's own scrolling pay for the rail.
   */
  const geometryRef = React.useRef({ content: 0, viewport: 0 });

  /**
   * Moves the overlay to where the framed page now is. The badges are in the
   * framed page's own coordinates and nothing about them changes when it
   * scrolls, so this offsets the one layer holding them and re-measures nothing.
   */
  const followScroll = React.useCallback(() => {
    const frameWindow = frameRef.current?.contentWindow ?? null;
    const layer = layerRef.current;
    const knob = knobRef.current;
    /* v8 ignore next 2 -- the frame, the layer and the knob are rendered
       unconditionally, so the compiler asks for a guard nothing can trip. */
    if (frameWindow === null || layer === null || knob === null) return;
    const offset = frameWindow.scrollY;
    layer.style.transform = `translateY(${String(-offset)}px)`;
    const { content, viewport } = geometryRef.current;
    // Nothing to be a fraction of until the page has been read once, which a
    // scroll can beat.
    if (content <= 0) return;
    knob.style.top = `${String((offset / content) * 100)}%`;
    knob.style.height = `${String(Math.max(viewport / content, MIN_KNOB_SHARE) * 100)}%`;
  }, []);

  const measure = React.useCallback(() => {
    const frame = frameRef.current;
    const frameDocument = frame?.contentDocument ?? null;
    const frameWindow = frame?.contentWindow ?? null;
    // Cleared rather than kept: a load that leaves the frame unreadable has
    // replaced the page the badges were measured against, and badges left over
    // it would state counts that page never earned.
    if (frameDocument === null || frameWindow === null) {
      setReading(NOTHING_READ);
      return;
    }
    const read = readFrame({
      frameDocument,
      frameWindow,
      page: framedPage,
      totals,
      viewport: { width: device, height: frameHeight },
    });
    geometryRef.current = { content: read.content.height, viewport: frameHeight };
    setReading(read);
    followScroll();
  }, [device, followScroll, frameHeight, framedPage, totals]);

  // The room the panel gives the frame is a measurement of this panel, never of
  // the page inside it. The width comes off the row, which spans the panel
  // whatever the frame does, rather than off the group the frame's own width
  // now sizes; the height comes off the box, which is the room the row's own
  // height leaves once its border and any sideways scrollbar have taken theirs.
  React.useEffect(() => {
    const row = rowRef.current;
    const box = boxRef.current;
    /* v8 ignore next -- the measured elements are rendered unconditionally. */
    if (row === null || box === null) return;
    const read = (): void => {
      setRoom({ width: frameRoom(row.clientWidth), height: box.clientHeight });
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(row);
    observer.observe(box);
    return () => {
      observer.disconnect();
    };
  }, []);

  // One path measures: mounting, every load, every change of what is being
  // framed or at what size, and every change of the framed page's own box. The
  // last is what keeps the reading true rather than merely first: a page goes on
  // settling after it has loaded, as its fonts arrive and its hero resolves, and
  // a box read before that names a place the page no longer puts anything. It
  // also covers the frame being resized, because the page relays itself out.
  React.useEffect(() => {
    measure();
    const frame = frameRef.current;
    const frameWindow = frame?.contentWindow ?? null;
    const frameDocument = frame?.contentDocument ?? null;
    if (frameWindow === null || frameDocument === null) return;
    frameWindow.addEventListener('scroll', followScroll);
    const settling = new ResizeObserver(measure);
    settling.observe(frameDocument.documentElement);
    return () => {
      frameWindow.removeEventListener('scroll', followScroll);
      settling.disconnect();
    };
  }, [followScroll, loads, measure]);

  const fields = React.useMemo(() => heatFields(reading.sources), [reading.sources]);
  const pageFields = React.useMemo(() => fields.filter((field) => !field.pinned), [fields]);
  const pinnedFields = React.useMemo(() => fields.filter((field) => field.pinned), [fields]);
  const bands = React.useMemo(
    () => railBands(reading.sources, Math.max(reading.content.height, 1), RAIL_BANDS),
    [reading.content.height, reading.sources]
  );

  // The heat's colours are the theme's own, read at paint time and read again
  // whenever the theme changes: a canvas paints outside the cascade, so nothing
  // else would move its fields off the palette they were painted from.
  const pageHeatHeight = reading.content.height;
  const pinnedHeatHeight = Math.round(frameHeight);
  const pageHeatRefused = usePaintedHeat(heatRef, pageFields, reading.root, pageHeatHeight);
  const pinnedHeatRefused = usePaintedHeat(
    pinnedHeatRef,
    pinnedFields,
    reading.root,
    pinnedHeatHeight
  );
  const heatRefused = pageHeatRefused || pinnedHeatRefused;

  const range = React.useMemo(() => heatRange(reading.sources), [reading.sources]);
  const most = range?.most ?? 0;
  const drawn = badgesFor(reading.badges, view);

  return (
    <div className="flex flex-col gap-2">
      {/* The row wraps rather than holding a width: at the largest font tier on
          a phone it has a third of the space its words need, and a control that
          keeps its width leaves the panel and the viewport with it. A segment
          never narrows below its own label, so a group wraps its segments
          instead. */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-slot="overlay-control"
          className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1 text-xs"
        >
          <span>Page</span>
          <SelectField
            label="Page"
            labelHidden
            size="sm"
            value={path}
            onValueChange={setPath}
            options={PAGE_OPTIONS}
            triggerText={(value) => (
              // The trigger holds room for the longest route in the very list the
              // options come from, stacked in one grid cell behind the chosen one.
              // Sized by its selected value instead, the control would resize and
              // shift the controls after it on every change; sized to a fixed
              // width, the longest routes would truncate at the scaled font tiers,
              // and the route name is the figure this panel's claim rests on.
              <span data-slot="overlay-page-sizer" className="grid font-mono text-xs">
                {MARKETING_ROUTES.map((route) => (
                  <span
                    key={route}
                    aria-hidden="true"
                    className="invisible col-start-1 row-start-1"
                  >
                    {route}
                  </span>
                ))}
                <span data-slot="overlay-page-value" className="col-start-1 row-start-1">
                  {value}
                </span>
              </span>
            )}
          />
        </span>
        <span
          data-slot="overlay-control"
          className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1 text-xs"
        >
          Device
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            aria-label="Device"
            className="flex-wrap"
            value={String(device)}
            onValueChange={(next) => {
              if (next !== '') setDevice(Number(next));
            }}
          >
            {DEVICES.map((option) => (
              <ToggleGroupItem
                key={option.width}
                value={String(option.width)}
                className={TOGGLE_ITEM_CLASS}
              >
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </span>
        <span
          data-slot="overlay-control"
          className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1 text-xs"
        >
          Show
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            aria-label="Show"
            className="flex-wrap"
            value={view}
            onValueChange={(next) => {
              if (next !== '') setView(next as OverlayView);
            }}
          >
            {VIEWS.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                className={TOGGLE_ITEM_CLASS}
              >
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </span>
        <p className="text-muted-foreground ml-auto font-mono text-xs">
          {`${String(device)}px wide, shown at ${String(Math.round(scale * 100))}%`}
        </p>
        {/* The copy this panel frames, not the public site: it is the document
            every badge on the frame was measured against, and the one the page
            control names. */}
        <a
          href={adminPreviewPath(path)}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${path} in a new tab`}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded p-1 focus-visible:ring-2 focus-visible:outline-hidden"
        >
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      </div>

      {/* The row is the panel's own width and the group inside it is the frame's:
          a device narrower than the room leaves that width outside the group's
          border, where it reads as a device standing on the panel, rather than
          inside it as an empty band beside the page. The row is also what the
          room is measured on, because the group is no longer independent of the
          frame it holds. The cap is a floor on the arithmetic rather than part
          of it: the row is measured to a whole pixel and a fractional row reads
          a pixel wide, which would put the group that fraction past its row. */}
      <div ref={rowRef} data-slot="overlay-row">
        <div
          data-slot="overlay-viewport"
          style={{ width: groupWidth(room.width, framedWidth), borderWidth: GROUP_BORDER }}
          // The group draws the region's focus ring: its own overflow clip would cut
          // away a ring drawn outside the region, and a scroller's own outline
          // paints under the framed page it scrolls.
          className="border-border bg-muted has-[:focus-visible]:ring-ring mx-auto flex h-[38rem] max-w-full overflow-hidden rounded has-[:focus-visible]:ring-2 has-[:focus-visible]:outline-hidden"
        >
          <ScrollRegion
            ref={boxRef}
            label={`Where people clicked on ${path}`}
            className="flex-1 overflow-x-auto overflow-y-hidden focus-visible:ring-0"
          >
            <div style={{ width: framedWidth, height: room.height }} className="relative">
              <div
                data-slot="overlay-stage"
                style={{ width: device, height: frameHeight, transform: `scale(${String(scale)})` }}
                className="absolute top-0 left-0 origin-top-left overflow-hidden"
              >
                <iframe
                  ref={frameRef}
                  title={`Marketing page ${path}`}
                  src={adminPreviewPath(path)}
                  sandbox="allow-same-origin"
                  onLoad={() => {
                    setLoads((count) => count + 1);
                  }}
                  style={{ width: device, height: frameHeight }}
                  className="border-0"
                />
                <div
                  ref={layerRef}
                  data-slot="overlay-document-layer"
                  style={{ width: reading.content.width, height: reading.content.height }}
                  className="pointer-events-none absolute top-0 left-0"
                >
                  {view !== 'counts' && pageFields.length > 0 && !pageHeatRefused && (
                    <canvas
                      ref={heatRef}
                      data-slot="overlay-heat"
                      aria-hidden="true"
                      width={device}
                      height={pageHeatHeight}
                      className="absolute top-0 left-0"
                    />
                  )}
                  <OverlayBadges
                    badges={drawn.filter((badge) => !badge.fixed)}
                    most={most}
                    scale={scale}
                  />
                </div>
                <div
                  data-slot="overlay-viewport-layer"
                  style={{ width: device, height: frameHeight }}
                  className="pointer-events-none absolute top-0 left-0"
                >
                  {view !== 'counts' && pinnedFields.length > 0 && !pinnedHeatRefused && (
                    <canvas
                      ref={pinnedHeatRef}
                      data-slot="overlay-heat"
                      aria-hidden="true"
                      width={device}
                      height={pinnedHeatHeight}
                      className="absolute top-0 left-0"
                    />
                  )}
                  <OverlayBadges
                    badges={drawn.filter((badge) => badge.fixed)}
                    most={most}
                    scale={scale}
                  />
                </div>
              </div>
            </div>
          </ScrollRegion>
          <div
            data-slot="overlay-rail"
            aria-hidden="true"
            style={{ width: RAIL_WIDTH }}
            className="border-border bg-background/50 relative flex shrink-0 flex-col gap-px border-l p-1"
          >
            {bands.map((step, index) => (
              <div
                // The bands are a fixed-length slicing of the page, so a band is
                // identified by where in the page it is and by nothing else.
                key={index}
                data-slot="overlay-rail-band"
                data-step={String(step)}
                className={cn(
                  'flex flex-1 items-center justify-center rounded-sm',
                  step > 0 && COHORT_STEP_CLASSES[step - 1]
                )}
              >
                {step === 0 && (
                  <span
                    data-slot="overlay-rail-nothing"
                    className="bg-border-strong block h-px w-2 rounded-full"
                  />
                )}
              </div>
            ))}
            <div
              ref={knobRef}
              data-slot="overlay-rail-knob"
              className="border-foreground absolute inset-x-1 rounded-sm border-2"
            />
          </div>
        </div>
      </div>

      <OverlayLegend range={range} refused={heatRefused} refusedHeight={pageHeatHeight} />

      <p data-slot="overlay-caption" className="text-muted-foreground max-w-[92ch] text-xs">
        The warmth is one soft field per counted link or button, shaped by that element&apos;s own
        box and weighted by its visitor count. The read carries no coordinate of any kind, so a warm
        area means the thing under it was clicked that often, never that anyone moved a pointer
        there. An element nobody clicked carries a dashed zero in the Counts view, which is a
        measurement; an element carrying no badge at all was one the page never laid out. The rail
        marks a part of the page with nothing counted in it with a dash rather than a shade, because
        the palest step of this ramp cannot be told from no shade at all. The page list is the
        site&apos;s own static pages, and the frame keeps a fixed height whatever the page inside it
        reports.
      </p>
    </div>
  );
}

/**
 * What the marks over the framed page mean: the ramp, and the two badges a
 * figure can be drawn as.
 *
 * Its own component because it is where most of the panel's conditions live —
 * a page with nothing counted, a page with no busiest element, a canvas the
 * browser would not draw — and each of them is about what the legend may
 * claim rather than about how the frame is built.
 */
function OverlayLegend({
  range,
  refused,
  refusedHeight,
}: Readonly<{
  readonly range: { readonly least: number; readonly most: number } | null;
  /** Whether the heat this legend would key was refused by the browser. */
  readonly refused: boolean;
  /** The page height the canvas was refused at, which the refusal states. */
  readonly refusedHeight: number;
}>): React.JSX.Element {
  return (
    <p
      data-slot="overlay-legend"
      className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
    >
      {/* The ramp key states what the heat encodes, so it stands only while
        the heat is on the page; the two badge keys below it describe marks
        that are drawn whatever the canvas did. */}
      {refused && (
        <span data-slot="overlay-heat-refused">
          {`The heat could not be drawn on this page: the browser refused a canvas ${String(refusedHeight)}px tall. Every figure is still on screen as a badge.`}
        </span>
      )}
      {!refused && range === null && (
        <span>Nothing on this page was clicked in what this read returned.</span>
      )}
      {!refused && range !== null && (
        <span className="flex items-center gap-1.5">
          Visitors
          <span className="flex overflow-hidden rounded-sm">
            {COHORT_STEP_CLASSES.map((step) => (
              <span key={step} className={cn('block h-2.5 w-4', step)} />
            ))}
          </span>
          <span className="font-mono">{`${String(range.least)} to ${String(range.most)}`}</span>
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            'flex h-4 items-center rounded px-1 font-mono text-[0.625rem] tabular-nums',
            BADGE_TONE_CLASSES.none
          )}
        >
          0
        </span>
        Counted nobody, badged in the Counts view
      </span>
      {/* Only where a page has a busiest element at all: a key stating "most
        clicked" beside a nought would name something nothing earned, and it
        would spend the brand red on the absence of a signal. */}
      {range !== null && (
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'flex h-4 items-center rounded px-1 font-mono text-[0.625rem] tabular-nums',
              BADGE_TONE_CLASSES.most
            )}
          >
            {range.most}
          </span>
          Most clicked on this page
        </span>
      )}
    </p>
  );
}

/**
 * The badges of one layer, each toned against the busiest figure on the page.
 *
 * One component for both layers rather than the same map written twice: the
 * document layer and the viewport layer differ in what they hold and in whether
 * the frame's scroll offset moves them, in nothing about how a badge is drawn.
 */
function OverlayBadges({
  badges,
  most,
  scale,
}: Readonly<{
  readonly badges: readonly PlacedBadge[];
  readonly most: number;
  readonly scale: number;
}>): React.JSX.Element {
  return (
    <>
      {badges.map((badge, index) => (
        <OverlayBadgeMark
          key={`${badge.eventName} ${String(index)}`}
          badge={badge}
          tone={toneOf(badge, most)}
          scale={scale}
        />
      ))}
    </>
  );
}

/**
 * One count, drawn over the element it was recorded against.
 *
 * Counter-scaled by the frame's own fit scale so the figure stays the size it
 * would be anywhere else on the screen: a badge shrunk with the frame would be
 * illegible at exactly the widths the frame has to shrink at.
 */
function OverlayBadgeMark({
  badge,
  tone,
  scale,
}: Readonly<{
  readonly badge: PlacedBadge;
  readonly tone: BadgeTone;
  readonly scale: number;
}>): React.JSX.Element {
  return (
    <span
      data-slot="overlay-badge"
      data-tone={tone}
      style={{
        left: badge.placement.left,
        top: badge.placement.top,
        minWidth: badge.width,
        height: BADGE_HEIGHT,
        transform: `scale(${String(1 / scale)})`,
      }}
      className={cn(
        'absolute flex origin-top-left items-center justify-center rounded px-1 font-mono text-xs tabular-nums',
        BADGE_TONE_CLASSES[tone]
      )}
    >
      <span className="sr-only">{badge.eventName}: </span>
      {badge.label}
    </span>
  );
}
