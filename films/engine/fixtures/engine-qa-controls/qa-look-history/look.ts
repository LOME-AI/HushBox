import type { RenderFrame } from '../../../look/index.js';

const COOKIE = 'films-look-history';
const COOKIE_VALUE = new RegExp(String.raw`(?:^|; )${COOKIE}=(\d+)-(\d+)`);
const DISC_PX = 160;
const RING_PX = 12;
const RING_GAP_PX = 6;
const SWEEP_PX = 24;
const SWEEP_FRAMES = 96;

/** What this browser has drawn so far: the highest frame, and how many draws came after it at a lower frame. */
interface History {
  highest: number;
  below: number;
}

/**
 * The history the browser keeps for the look, read from a cookie: a cookie
 * ignores the port, so it outlives the page and the server port each still
 * gets, and lives as long as the browser does.
 */
function readHistory(): History | null {
  const match = COOKIE_VALUE.exec(document.cookie);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  return { highest: Number(match[1]), below: Number(match[2]) };
}

function writeHistory({ highest, below }: History): void {
  document.cookie = `${COOKIE}=${String(highest)}-${String(below)}; path=/`;
}

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * A bar sweeping across the brand's field, and the same disc on every frame. A
 * frame drawn after a later frame in the same browser gains a ring around the
 * disc for each such draw up to it, so its picture follows the order the
 * browser drew in, not the frame: a browser that draws in ascending order never
 * shows a ring.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  const { context: paint, width, height, brand } = ctx;
  const history = readHistory() ?? { highest: frame, below: 0 };
  const late = history.highest > frame;
  const rings = late ? history.below + 1 : 0;
  writeHistory({
    highest: Math.max(history.highest, frame),
    below: late ? history.below + 1 : history.below,
  });
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  paint.fillStyle = brand.foreground;
  paint.fillRect(((frame % SWEEP_FRAMES) / SWEEP_FRAMES) * (width - SWEEP_PX), 0, SWEEP_PX, height);
  paint.strokeStyle = brand.brandRed;
  paint.lineWidth = RING_PX;
  for (let ring = 1; ring <= rings; ring += 1) {
    paint.beginPath();
    paint.arc(width / 2, height / 2, DISC_PX + ring * (RING_PX + RING_GAP_PX), 0, 2 * Math.PI);
    paint.stroke();
  }
  paint.fillStyle = brand.foreground;
  paint.beginPath();
  paint.arc(width / 2, height / 2, DISC_PX, 0, 2 * Math.PI);
  paint.fill();
  return [];
};
