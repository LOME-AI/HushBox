import { describe, expect, it } from 'vitest';
import {
  badgePlacement,
  badgeSize,
  fitScale,
  frameRoom,
  GROUP_BORDER,
  groupWidth,
  inFixedViewport,
  isMeasurable,
  MIN_FIT_SCALE,
  overlayBadge,
  RAIL_WIDTH,
} from './click-overlay-boxes.js';

/** A badge box wide enough to run past a narrow page's right edge. */
const BADGE = { width: 40, height: 16 } as const;

/** A page with room on every side, so only the rule under test moves a badge. */
const ROOMY = { width: 1000, height: 2000 } as const;

describe('badgePlacement', () => {
  it('hangs the badge directly above the element it labels', () => {
    expect(badgePlacement({ left: 100, top: 50, width: 200, height: 30 }, BADGE, ROOMY)).toEqual({
      left: 100,
      top: 34,
    });
  });

  it('drops the badge inside an element with no room above it', () => {
    expect(badgePlacement({ left: 0, top: 4, width: 200, height: 30 }, BADGE, ROOMY)).toEqual({
      left: 0,
      top: 4,
    });
  });

  it('shifts a badge at the right edge back inside the page', () => {
    expect(badgePlacement({ left: 980, top: 50, width: 20, height: 30 }, BADGE, ROOMY)).toEqual({
      left: 960,
      top: 34,
    });
  });

  it('keeps a badge on an element positioned off the left edge inside the page', () => {
    expect(badgePlacement({ left: -300, top: 50, width: 200, height: 30 }, BADGE, ROOMY)).toEqual({
      left: 0,
      top: 34,
    });
  });

  it('puts the badge at the origin when the page is smaller than the badge', () => {
    expect(
      badgePlacement({ left: 5, top: 5, width: 10, height: 10 }, BADGE, { width: 20, height: 8 })
    ).toEqual({ left: 0, top: 0 });
  });
});

/** The framed page, as the overlay is handed it. */
const PAGE = { basePath: '/preview', path: '/welcome' } as const;

/** The markup's first element, as the overlay reads it out of the frame. */
function element(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  const first = host.firstElementChild;
  if (first === null) throw new Error('fixture markup produced no element');
  return first;
}

describe('overlayBadge', () => {
  it('badges an element with the count recorded against its derived name', () => {
    const badge = overlayBadge(element('<a href="/chat">Start</a>'), PAGE, [
      { eventName: 'link:/chat', path: '/welcome', visitors: 42, overflow: false },
    ]);
    expect(badge).toEqual({ eventName: 'link:/chat', visitors: 42, overflow: false });
  });

  it('badges an element nothing was counted against with zero', () => {
    expect(overlayBadge(element('<button>Start</button>'), PAGE, [])).toEqual({
      eventName: 'start',
      visitors: 0,
      overflow: false,
    });
  });

  it('leaves an element the derivation names nothing for unbadged', () => {
    expect(overlayBadge(element('<button>→</button>'), PAGE, [])).toBeNull();
  });

  it('ignores a count the same name carries on another page', () => {
    const badge = overlayBadge(element('<a href="/chat">Start</a>'), PAGE, [
      { eventName: 'link:/chat', path: '/roadmap', visitors: 42, overflow: false },
    ]);
    expect(badge?.visitors).toBe(0);
  });

  it('carries the ceiling flag onto the badge', () => {
    const badge = overlayBadge(element('<a href="/chat">Start</a>'), PAGE, [
      { eventName: 'link:/chat', path: '/welcome', visitors: 42, overflow: true },
    ]);
    expect(badge?.overflow).toBe(true);
  });

  it('names a link carrying the frame prefix after the page the site serves', () => {
    const badge = overlayBadge(element('<a href="/preview/chat">Start</a>'), PAGE, []);
    expect(badge?.eventName).toBe('link:/chat');
  });

  it('names the frame prefix itself after the site root', () => {
    const badge = overlayBadge(element('<a href="/preview">Home</a>'), PAGE, []);
    expect(badge?.eventName).toBe('link:/');
  });

  it('leaves a path that merely starts with the prefix alone', () => {
    const badge = overlayBadge(element('<a href="/previews">Other</a>'), PAGE, []);
    expect(badge?.eventName).toBe('link:/previews');
  });
});

describe('badgeSize', () => {
  it('gives every badge the same height', () => {
    expect(badgeSize('7').height).toBe(badgeSize('1,234,567').height);
  });

  it('widens for a longer count so the page edge still clamps it correctly', () => {
    expect(badgeSize('1,234,567').width).toBeGreaterThan(badgeSize('7').width);
  });
});

describe('isMeasurable', () => {
  it('accepts an element the page actually lays out', () => {
    expect(isMeasurable({ left: 0, top: 0, width: 120, height: 40 })).toBe(true);
  });

  it('rejects an element with no width, which a hidden menu collapses to', () => {
    expect(isMeasurable({ left: 0, top: 0, width: 0, height: 40 })).toBe(false);
  });

  it('rejects an element with no height', () => {
    expect(isMeasurable({ left: 0, top: 0, width: 120, height: 0 })).toBe(false);
  });
});

describe('inFixedViewport', () => {
  /**
   * The one element `selector` names inside a parsed page, and the window the
   * page's own styles are resolved against, which is how the overlay reads a
   * framed document.
   */
  function target(html: string, selector: string): { element: Element; view: Window } {
    const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const element = parsed.querySelector(selector);
    if (element === null) throw new Error(`nothing matched ${selector}`);
    const view = parsed.defaultView;
    if (view === null) throw new Error('the parsed page has no window');
    return { element, view };
  }

  it('reads an element the page positions against its own viewport as fixed', () => {
    const { element, view } = target('<a style="position:fixed" href="/chat">Start</a>', 'a');
    expect(inFixedViewport(element, view)).toBe(true);
  });

  it('reads an element inside a fixed ancestor as fixed, which a fixed header holds', () => {
    const { element, view } = target(
      '<header style="position:fixed"><nav><a href="/chat">Start</a></nav></header>',
      'a'
    );
    expect(inFixedViewport(element, view)).toBe(true);
  });

  it('reads an element the page lays out in its document as not fixed', () => {
    const { element, view } = target('<main><a href="/chat">Start</a></main>', 'a');
    expect(inFixedViewport(element, view)).toBe(false);
  });
});

describe('fitScale', () => {
  it('shrinks a device wider than the room it is shown in', () => {
    expect(fitScale(1024, 1280)).toBeCloseTo(0.8);
  });

  it('leaves a device narrower than the room at its own size rather than blowing it up', () => {
    expect(fitScale(1024, 390)).toBe(1);
  });

  it('stops shrinking at the floor, below which the frame is scrolled sideways instead', () => {
    expect(fitScale(200, 1280)).toBe(MIN_FIT_SCALE);
  });

  it('holds the floor while the room is still unmeasured', () => {
    expect(fitScale(0, 1280)).toBe(MIN_FIT_SCALE);
  });
});

describe('frameRoom', () => {
  it('leaves the rail and the group border out of the room the frame may fill', () => {
    expect(frameRoom(1052)).toBe(1052 - RAIL_WIDTH - 2 * GROUP_BORDER);
  });

  it('reports no room at all on a row too narrow for the rail beside the frame', () => {
    expect(frameRoom(10)).toBe(0);
  });

  it('reports no room while the row is still unmeasured', () => {
    expect(frameRoom(0)).toBe(0);
  });
});

describe('groupWidth', () => {
  it('collapses the group to the framed device and the rail beside it', () => {
    expect(groupWidth(1024, 390)).toBe(`${String(390 + RAIL_WIDTH + 2 * GROUP_BORDER)}px`);
  });

  it('takes the whole room where the frame is wider than the room holding it', () => {
    expect(groupWidth(1024, 1536)).toBe(`${String(1024 + RAIL_WIDTH + 2 * GROUP_BORDER)}px`);
  });

  it('holds the frame exactly where the frame fills the room it was fitted to', () => {
    expect(groupWidth(1024, 1024)).toBe(`${String(1024 + RAIL_WIDTH + 2 * GROUP_BORDER)}px`);
  });

  it('spans a row nothing has measured yet, as the group drew before it collapsed', () => {
    expect(groupWidth(0, 768)).toBe('100%');
  });
});
