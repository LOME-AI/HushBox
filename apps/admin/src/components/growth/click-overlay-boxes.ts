import { deriveEventName } from '@hushbox/shared';

import type { EventTotal } from './events-panel.js';
import type { EventNameElement } from '@hushbox/shared';

/** A box in the framed page's own document coordinates. */
export interface OverlayRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A width and a height in CSS pixels. */
export interface OverlaySize {
  readonly width: number;
  readonly height: number;
}

/** Where a badge's top-left corner sits, in the framed page's coordinates. */
export interface BadgePlacement {
  readonly left: number;
  readonly top: number;
}

/** `value` brought inside `[0, limit]`, with a negative limit read as zero. */
function clamp(value: number, limit: number): number {
  if (value < 0 || limit < 0) return 0;
  return Math.min(value, limit);
}

/**
 * Where the badge for `element` sits on a page of `content` size.
 *
 * It hangs above the element's top-left corner so the copy it labels stays
 * readable, and drops onto the element itself only when there is no room above
 * — an element flush with the top of the page would otherwise carry a badge
 * the page cannot show. Both results are then brought inside the page, because
 * the site positions elements off-canvas (a closed menu sits to the left of the
 * viewport) and a badge left out there would be unreachable while the element
 * it names is one breakpoint away from being visible.
 */
export function badgePlacement(
  element: OverlayRect,
  badge: OverlaySize,
  content: OverlaySize
): BadgePlacement {
  const above = element.top - badge.height;
  return {
    left: clamp(element.left, content.width - badge.width),
    top: clamp(above < 0 ? element.top : above, content.height - badge.height),
  };
}

/** The height every badge draws at, and what the placement reserves above an element. */
export const BADGE_HEIGHT = 16;

/** Room for the badge's own padding, beyond the width of the count it states. */
const BADGE_PADDING = 10;

/**
 * An upper bound on one character's width in the badge's monospace type, so a
 * badge clamped at the page's right edge never ends up hanging over it. An
 * over-estimate is the safe direction: it shifts a wide badge slightly further
 * inside the page rather than leaving part of it unreachable.
 */
const BADGE_CHARACTER_WIDTH = 8;

/** The framed page, as the overlay is handed it. */
export interface OverlayPage {
  /** The prefix the admin origin serves the framed copy of the site under. */
  readonly basePath: string;
  /** The site's own path for the framed page, which its counts are keyed by. */
  readonly path: string;
}

/** What one element's badge states. */
export interface OverlayBadge {
  readonly eventName: string;
  readonly visitors: number;
  readonly overflow: boolean;
}

/** The box a badge stating `label` occupies. */
export function badgeSize(label: string): OverlaySize {
  return { width: BADGE_PADDING + label.length * BADGE_CHARACTER_WIDTH, height: BADGE_HEIGHT };
}

/**
 * Whether the page laid `rect` out at all. A page hides its narrow-viewport
 * navigation at the width the overlay frames it at, and every element inside it
 * collapses to a box with no area — badging those would stack a copy of half
 * the page's names on one corner.
 */
export function isMeasurable(rect: OverlayRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

/**
 * Whether the framed page positions `element` against the frame's viewport
 * rather than against its own document.
 *
 * The distinction decides which layer badges it: a badge over a document-
 * positioned element rides the layer the frame's scroll offset translates, and
 * one over a fixed element must not, because the element it names does not move
 * when the document under it does. The site's own landing header is the case
 * this exists for, and it holds most of the page's links.
 *
 * The whole ancestor chain is walked rather than the element alone: `position`
 * does not inherit, but a fixed ancestor takes every descendant out of the
 * document's scrolling flow with it.
 */
export function inFixedViewport(element: Element, view: Window): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (view.getComputedStyle(node).position === 'fixed') return true;
  }
  return false;
}

/**
 * `href` as the site itself serves it. The framed copy is served under a
 * prefix, so a link inside it that carries the prefix names the same page the
 * site serves without it, and the beacon counted the name without it.
 */
function sitePath(href: string, basePath: string): string {
  if (href === basePath) return '/';
  return href.startsWith(`${basePath}/`) ? href.slice(basePath.length) : href;
}

/**
 * `element` as the derivation would have read it on the site itself: the same
 * markup, with the frame's own prefix taken back off the destination.
 */
function asSiteElement(element: Element, basePath: string): EventNameElement {
  return {
    tagName: element.tagName,
    textContent: element.textContent,
    getAttribute: (name) => {
      const value = element.getAttribute(name);
      if (name !== 'href' || value === null) return value;
      return sitePath(value, basePath);
    },
  };
}

/**
 * What `element` is badged with, or `null` when it derives no name and so is
 * something the beacon never counts.
 *
 * The name comes from the shared derivation the marketing script and the build's
 * name extractor run, so a badge states the series the beacon actually wrote
 * rather than a series the overlay believes it wrote. The count is whatever
 * `totals` holds for that name on this page; an element nobody clicked badges
 * zero, which is a measurement, where an unbadged element is one that was never
 * measurable.
 */
export function overlayBadge(
  element: Element,
  page: OverlayPage,
  totals: readonly EventTotal[]
): OverlayBadge | null {
  const eventName = deriveEventName(asSiteElement(element, page.basePath));
  if (eventName === null) return null;
  const total = totals.find(
    (candidate) => candidate.eventName === eventName && candidate.path === page.path
  );
  return {
    eventName,
    visitors: total?.visitors ?? 0,
    overflow: total?.overflow ?? false,
  };
}

/**
 * How far the frame is allowed to shrink to fit the room the panel has. Past
 * this the copy inside it stops being legible as a page, so the frame keeps its
 * size and the panel scrolls it sideways instead.
 */
export const MIN_FIT_SCALE = 0.6;

/**
 * What the frame is drawn at to fit `room` pixels of panel width while standing
 * for a device `deviceWidth` wide.
 *
 * Never above 1: a device narrower than the panel is shown at its own size,
 * because a blown-up phone frame would state a page no visitor was served.
 */
export function fitScale(room: number, deviceWidth: number): number {
  return clamp(Math.max(room / deviceWidth, MIN_FIT_SCALE), 1);
}

/**
 * The density rail's own width, beside the frame. Written down once: the rail
 * wears it and the room the frame may fill is what its row offers less this, so
 * a second spelling would let the frame's room drift from the strip taking it.
 */
export const RAIL_WIDTH = 26;

/** The bordered group's own border, on each of the two sides the row offers width on. */
export const GROUP_BORDER = 1;

/**
 * The room the frame may fill inside a row `rowWidth` wide: what the row
 * offers, less the group's own border and the rail standing beside the frame.
 *
 * Read off the row rather than off the frame's own box, because the box is
 * sized to the frame it holds: a scale read from there would set the width that
 * set it, and each measurement would move the next — which is the divergence
 * the frame's height already answers for, in the other axis.
 */
export function frameRoom(rowWidth: number): number {
  return Math.max(rowWidth - 2 * GROUP_BORDER - RAIL_WIDTH, 0);
}

/**
 * How wide the bordered group is drawn, around a frame `framedWidth` wide in
 * `room` pixels of room: the frame and the rail beside it and nothing more, so
 * the width the frame does not want falls outside the group's border instead of
 * standing as an empty band inside it.
 *
 * A frame wider than its room — what the fit scale's floor produces — takes the
 * whole room, and the group spans the row with the frame scrolling inside it. A
 * row nothing has measured yet spans it too, which is what the group drew before
 * it collapsed at all: read against a room of nothing it would be drawn at the
 * width of its own chrome, for the one paint before the measurement lands.
 */
export function groupWidth(room: number, framedWidth: number): string {
  if (room === 0) return '100%';
  return `${String(Math.min(framedWidth, room) + 2 * GROUP_BORDER + RAIL_WIDTH)}px`;
}
