// The page population the reader search runs over: one shape per position from
// which a rule could reach the font size of the element under test, with that
// element left as a placeholder so each shape is driven as a `sub`, as a `sup`
// and as a `span`.
//
// `span` is the control. The default sheet states no size for it, so a `span`
// row that moves under any arm means the arm reached something it did not name.
// It is a control and not a subject: `span` is a safe tag for the contrast rules
// and an allowed tag for the kicker rule, so a shape can be silent in that
// column for reasons that have nothing to do with a size. Every arm names the
// subjects it may move, and a moved row on any other subject is a leak the sweep
// refuses rather than reports.
//
// EACH SHAPE IS BUILT TO STRADDLE ONE THRESHOLD, not merely to trigger one rule.
// A shape that fires on both sides of the change proves nothing about whether
// the rule read the size; a shape whose verdict turns on it does. The straddles
// are stated in each shape's `straddles` field, in the units the rule compares,
// and each number in one was checked against the rule's own constant rather than
// recalled: the large-text bar is 18pt, which is 24px, and the bold bar is 14pt,
// which is 18.67px.
//
// The `%T%` placeholder is the element under test. `%OPEN%`/`%CLOSE%` are the
// same element when a shape needs the rules to read a DESCENDANT of it instead,
// which is the inheritance path.

const COPY =
  'Body copy that is comfortably longer than fifty characters, long enough to clear the floor.';

const HEADLINE = 'A headline long enough to clear the forty character floor';

/**
 * @typedef {{ id: string, straddles: string, style?: string, body: string }} Shape
 */

/** @type {readonly Shape[]} */
const SHAPES = [
  {
    id: 'tiny-text-straddle',
    straddles: 'the 12px floor: 13px above it, 10.83px below',
    body: `<div style="font-size:13px"><%T%>${COPY}</%T%></div>`,
  },
  {
    id: 'tiny-text-both-sides-below-the-floor',
    straddles:
      'nothing — both sizes are under the floor, so what the rule says here is decided by its skip list rather than by a size',
    body: `<div style="font-size:11px"><%T%>${COPY}</%T%></div>`,
  },
  {
    id: 'wide-tracking-px-straddle',
    straddles: '0.6px of tracking against the 0.05em floor: 0.046em at 13px, 0.055em at 10.83px',
    body: `<div style="font-size:13px"><%T% style="letter-spacing:0.6px">${COPY}</%T%></div>`,
  },
  {
    id: 'wide-tracking-em-invariant',
    straddles: 'nothing — an em tracking is the same ratio at either size',
    body: `<div style="font-size:13px"><%T% style="letter-spacing:0.06em">${COPY}</%T%></div>`,
  },
  {
    id: 'negative-tracking-px-straddle',
    straddles: '-0.6px against the -0.05em floor: -0.046em at 13px, -0.055em at 10.83px',
    body: `<div style="font-size:13px"><%T% style="letter-spacing:-0.6px">${COPY}</%T%></div>`,
  },
  {
    id: 'tight-leading-straddle',
    straddles: 'a 15px leading against the 1.3 floor: 1.15x at 13px, 1.38x at 10.83px',
    body: `<div style="font-size:13px"><%T% style="line-height:15px">${COPY}</%T%></div>`,
  },
  {
    id: 'contrast-large-text-bar-straddle',
    straddles: 'the 24px bar that selects between the 3:1 and 4.5:1 minimums: 26px above it, 21.67px below',
    style: 'body{background-color:#ffffff}',
    body: `<div style="font-size:26px"><%T% style="color:#949494">${COPY}</%T%></div>`,
  },
  {
    id: 'contrast-bold-text-bar-straddle',
    straddles: 'the 18.67px bar the same rule uses for bold text: 20px above it, 16.67px below',
    style: 'body{background-color:#ffffff}',
    body: `<div style="font-size:20px"><%T% style="color:#949494;font-weight:700">${COPY}</%T%></div>`,
  },
  {
    id: 'purple-heading-size-gate',
    straddles:
      'the 20px gate the purple-text rule uses to treat an element as heading-scale: 23px above it, 19.17px below',
    style: 'body{background-color:#ffffff}',
    body: `<div style="font-size:23px"><%T% style="color:#9333ea">${COPY}</%T%></div>`,
  },
  {
    id: 'type-hierarchy-via-descendant',
    straddles: 'the 2.0 hierarchy ratio: 34/16 = 2.13 above it, 28.33/16 = 1.77 below',
    style: 'p{font-size:16px}li{font-size:17px}',
    body:
      `<p>${COPY}</p><ul><li>${COPY}</li></ul>` +
      // The wrapper is a `section` and not a `div`: the size population is the
      // page-level text scan's, which counts a `div`, so a `div` here would put
      // the wrapper's own 34px into the set and hold the ratio fixed whatever
      // the element below it renders at.
      `<section style="font-size:34px">%OPEN%<span>${COPY}</span>%CLOSE%</section>`,
  },
  {
    id: 'tracking-via-descendant',
    straddles: 'the same 0.05em floor, reached through one inheritance step',
    body: `<div style="font-size:13px">%OPEN%<span style="letter-spacing:0.6px">${COPY}</span>%CLOSE%</div>`,
  },
  {
    id: 'hero-eyebrow-size-gate',
    straddles: 'the 14px ceiling an eyebrow must sit under: 16px above it, 13.33px below',
    body:
      '<div><%T% style="text-transform:uppercase;letter-spacing:2px">LAUNCH WEEK</%T%>' +
      '<h1>A hero heading long enough to read as one</h1></div>',
  },
  {
    id: 'repeated-kicker-size-gate',
    straddles:
      'nothing on this subject — the kicker rule takes an allowlist of tags, and the shape is sized so the control sits under the same 14px ceiling',
    body: [1, 2, 3]
      .map(
        (n) =>
          `<section style="font-size:13px"><%T% style="text-transform:uppercase;letter-spacing:2px">SECTION LABEL</%T%>` +
          `<h2 style="font-size:24px">Section heading number ${n}</h2></section>`
      )
      .join(''),
  },
  {
    id: 'repeated-kicker-size-gate-at-the-ceiling',
    straddles:
      'the kicker rule 14px ceiling: 16px above it, 13.33px below. The shape above shows the rule reachable; this one is where a subject the rule admits would cross',
    body: [1, 2, 3]
      .map(
        (n) =>
          `<section style="font-size:16px"><%T% style="text-transform:uppercase;letter-spacing:2px">SECTION LABEL</%T%>` +
          `<h2 style="font-size:24px">Section heading number ${n}</h2></section>`
      )
      .join(''),
  },
  {
    id: 'cramped-padding-shape',
    straddles: 'nothing in this engine — the rule needs a layout rectangle the static engine has none of',
    body:
      `<div style="font-size:13px"><%T% style="padding:2px;border:1px solid #000000;background-color:#eeeeee">` +
      `${COPY}</%T%></div>`,
  },
  {
    id: 'unpriceable-ancestor-guard',
    straddles: 'nothing — the size above cannot be priced, so the sheet is not applied',
    body: `<div style="font-size:4vw"><%T% style="letter-spacing:0.6px">${COPY}</%T%></div>`,
  },
  {
    id: 'own-size-stated-guard',
    straddles: 'nothing — the element states its own size, which outranks the sheet',
    body: `<div style="font-size:13px"><%T% style="font-size:20px;letter-spacing:0.6px">${COPY}</%T%></div>`,
  },
  {
    id: 'own-size-stated-by-a-utility-class-guard',
    straddles: 'nothing — a utility class states the size, which outranks the sheet',
    body: `<div style="font-size:13px"><%T% class="text-xs" style="letter-spacing:0.6px">${COPY}</%T%></div>`,
  },
  {
    id: 'inside-an-oversized-h1',
    straddles: 'nothing — the heading rule reads the heading own size, not its child',
    body: `<div style="font-size:96px"><h1>Hero heading with <%T%>an inline mark</%T%> inside it</h1></div>`,
  },
  {
    id: 'all-caps-and-justified-controls',
    straddles: 'nothing — neither rule reads a size',
    body: `<div style="font-size:13px"><%T% style="text-transform:uppercase;text-align:justify">${COPY}</%T%></div>`,
  },

  // --- the four positions a size reaches that the first population had no
  // shape for. Each was found by driving the pre-image against this tree after
  // the population above had reported the search closed twice.

  {
    id: 'oversized-heading-through-a-descendant-heading',
    straddles:
      'the 72px an over-large hero must clear: an h1 at 2em of a 40px section is 80px above it, and 66.67px below',
    style: 'section{font-size:40px}h1{font-size:2em}',
    body: `<section>%OPEN%<h1>${HEADLINE}</h1>%CLOSE%</section>`,
  },
  {
    id: 'italic-serif-display-through-a-descendant-heading',
    straddles:
      'the 48px this rule anchors on: an h1 at 2em of a 25px section is 50px above it, and 41.67px below',
    style: 'section{font-size:25px}h1{font-size:2em;font-style:italic;font-family:Georgia,serif}',
    body: `<section>%OPEN%<h1>${HEADLINE}</h1>%CLOSE%</section>`,
  },
  {
    // The rule's other arm — the one that needs no layout rectangle. It resolves
    // every padding against the font size, so an `em` inset crosses the
    // near-zero threshold on one side of the change and not the other.
    id: 'flush-against-a-boundary-with-an-em-inset',
    straddles:
      'the near-zero inset a bounded container must clear: 0.12em of a 20px section is 2.4px above it, and 2px of the 16.67px below it',
    style: 'section{font-size:20px}.card{border:1px solid #cc0000;padding:0.12em}',
    body: `<section>%OPEN%<div class="card"><p>${COPY}</p></div>%CLOSE%</section>`,
  },
  {
    // The allowlist closes the door on the subject standing AS the kicker. It
    // closes nothing on the subject standing AROUND one: the kicker and the
    // heading both take their size through it, by inheritance, which is gated by
    // nothing.
    id: 'repeated-kickers-through-a-wrapping-subject',
    straddles:
      'the same 14px ceiling, reached by inheritance: a kicker in a 16px section is 16px above it, and 13.33px below',
    style: 'section{font-size:16px}h2{font-size:1.5em}',
    body: [1, 2, 3]
      .map(
        (n) =>
          `<section>%OPEN%<span style="text-transform:uppercase;letter-spacing:2px">SECTION LABEL</span>` +
          `<h2>Section heading number ${n}</h2>%CLOSE%</section>`
      )
      .join(''),
  },
  {
    id: 'negative-tracking-through-a-descendant',
    straddles: 'the -0.05em floor: -0.9px is -0.045em at 20px, and -0.054em at 16.67px',
    style: 'section{font-size:20px}',
    body: `<section>%OPEN%<span style="letter-spacing:-0.9px">${COPY}</span>%CLOSE%</section>`,
  },

  // --- shapes that exist to make a rule RUN. -------------------------------
  //
  // A rule the derivation admits and no page here fires is scored "not reached",
  // which is the reading that let four movers hide: it cannot be told apart from
  // a rule that ran and declined. Each shape below fires exactly the rule it is
  // named for, so that rule's non-movement is a measurement rather than a gap.
  // None of them carries the subject: a rule that reads no size answers the same
  // whatever the subject renders at, and the sweep asserts that it does.

  {
    id: 'side-accent-stripe',
    straddles: 'nothing — the border rules read widths, colours and a radius, never a size',
    style: '.card{border-left:4px solid #cc0000;border-radius:8px;background-color:#eeeeee;padding:20px}',
    body: `<div class="card"><p>${COPY}</p></div>`,
  },
  {
    id: 'top-accent-on-a-rounded-card',
    straddles: 'nothing — the same rule, its other arm',
    style: '.card{border-top:3px solid #cc0000;border-radius:8px;background-color:#eeeeee;padding:20px}',
    body: `<div class="card"><p>${COPY}</p></div>`,
  },
  {
    id: 'an-overused-face',
    straddles: 'nothing — the typography rule reads the family, never the size',
    style: 'body{font-family:Inter,sans-serif}',
    body: `<p>${COPY}</p>`,
  },
  {
    id: 'gradient-clipped-heading-text',
    straddles: 'nothing — the gradient rule reads the clip and the image, never the size',
    style:
      'h2{background-image:linear-gradient(90deg,#9333ea,#06b6d4);-webkit-background-clip:text;color:transparent;font-size:32px}',
    body: '<h2>A gradient heading long enough to read</h2>',
  },
  {
    id: 'bounce-timing-function',
    straddles: 'nothing — the motion rules read timing functions, never a size',
    style: '.b{transition-property:transform;transition-timing-function:cubic-bezier(0.68,-0.55,0.265,1.55)}',
    body: `<div class="b"><p>${COPY}</p></div>`,
  },
  {
    id: 'dark-surface-with-a-glow',
    straddles: 'nothing — the glow rule reads the shadow and the surface, never a size',
    style:
      'body{background-color:#0a0a0f}.g{background-color:#12121a;box-shadow:0 0 40px rgba(147,51,234,0.7);padding:20px;color:#eeeeee}',
    body: `<div class="g"><p>${COPY}</p></div>`,
  },
  {
    id: 'icon-tile-above-a-heading',
    straddles: 'nothing — the tile rule reads the tile box, never a size',
    style: '.tile{width:48px;height:48px;background-color:#9333ea;border-radius:8px}h2{font-size:24px}',
    body: '<section><div class="tile"><svg width="24" height="24"></svg></div><h2>A section heading here</h2></section>',
  },
  {
    id: 'gray-text-on-a-coloured-surface',
    straddles: 'nothing — this arm of the colour rule reads two colours, never a size',
    style: '.c{background-color:#9333ea;padding:20px}',
    body: `<div class="c"><p style="color:#8a8a8a">${COPY}</p></div>`,
  },
  {
    id: 'justified-without-hyphens',
    straddles: 'nothing — the rule reads the alignment and the hyphenation, never a size',
    body: `<p style="text-align:justify">${COPY}</p>`,
  },
  {
    id: 'an-all-caps-paragraph',
    straddles: 'nothing — the rule reads the transform and the character count, never a size',
    body: `<p style="text-transform:uppercase">${COPY}</p>`,
  },
  {
    id: 'a-clipped-positioned-child',
    straddles: 'nothing — the clipping rule reads overflow and position, never a size',
    style: '.clip{overflow:hidden;position:relative;width:200px;height:100px}.pop{position:absolute;top:-40px;left:0}',
    body: `<div class="clip"><div class="pop"><p>${COPY}</p></div></div>`,
  },
];

// `small` rides the same population, under its own arm. The rules that read it
// were accounted for once, as two, by reading; running it through the same
// search is what says whether that account was complete.
const SUBJECTS = ['sub', 'sup', 'small', 'span'];

/**
 * WHAT THIS POPULATION OWES THE DERIVATION.
 *
 * `derivation.mjs` computes, from the engine's own source, the ids a modelled
 * size can reach. That set is what the population has to cover, and this map is
 * where each member is answered. Every entry is enforced by the sweep, so an
 * entry that stops being true stops the sweep rather than ageing quietly:
 *
 *   moves          the population straddles this rule's gate and the verdict
 *                  turns on the modelled size. The sweep requires it to move.
 *   runs-declines  a page here makes the rule run, and it answers the same at
 *                  every size. The sweep requires it to be emitted and to hold
 *                  still. This is the disposition that cannot be reached by
 *                  reading: it is the difference between a rule that declined
 *                  and a rule no page ever ran.
 *   cannot-run     the rule cannot fire in this engine at all, for a reason
 *                  that is a property of the engine rather than of the
 *                  population. The sweep requires it never to be emitted.
 *
 * An id the derivation admits and this map does not answer stops the sweep. That
 * is the whole point: four movers hid in the gap between "the population reached
 * thirteen ids" and "the population covered what it had to".
 *
 * @type {Record<string, { disposition: 'moves' | 'runs-declines' | 'cannot-run', why: string }>}
 */
const DISPOSITIONS = {
  // --- the twelve that move ------------------------------------------------
  'wide-tracking': { disposition: 'moves', why: 'the tracking floor is a ratio of the size' },
  'extreme-negative-tracking': { disposition: 'moves', why: 'the same floor, mirrored' },
  'tight-leading': { disposition: 'moves', why: 'the leading floor is a ratio of the size' },
  'low-contrast': { disposition: 'moves', why: 'the size selects between the two contrast minimums' },
  'ai-color-palette': { disposition: 'moves', why: 'the size decides whether the element is heading-scale' },
  'flat-type-hierarchy': { disposition: 'moves', why: 'the page-wide size scan reaches it through a descendant' },
  'hero-eyebrow-chip': { disposition: 'moves', why: 'an eyebrow is admitted only under a size ceiling' },
  'tiny-text': {
    disposition: 'moves',
    why: 'the floor it reports at — reached through a descendant, because its skip list covers the element and not what inherits from it',
  },
  'oversized-h1': {
    disposition: 'moves',
    why: 'it reads the heading own size, and a heading can be the descendant',
  },
  'italic-serif-display': {
    disposition: 'moves',
    why: 'the same, at its own size anchor',
  },
  'cramped-padding': {
    disposition: 'moves',
    why: 'the flush-against-a-boundary arm needs no rectangle and resolves every inset against the size',
  },
  'repeated-section-kickers': {
    disposition: 'moves',
    why: 'a kicker is admitted only under a size ceiling',
  },

  // --- the rules a page here runs, which answer the same at every size ------
  'side-tab': { disposition: 'runs-declines', why: 'reads border widths, colours and a radius' },
  'border-accent-on-rounded': { disposition: 'runs-declines', why: 'the same rule, its other arm' },
  'overused-font': { disposition: 'runs-declines', why: 'reads the family name' },
  'gradient-text': { disposition: 'runs-declines', why: 'reads the background clip and image' },
  'bounce-easing': { disposition: 'runs-declines', why: 'reads timing functions' },
  'dark-glow': { disposition: 'runs-declines', why: 'reads the shadow and the surface colour' },
  'icon-tile-stack': { disposition: 'runs-declines', why: 'reads the tile box and its child' },
  'gray-on-color': { disposition: 'runs-declines', why: 'this arm compares two colours only' },
  'justified-text': { disposition: 'runs-declines', why: 'reads the alignment and the hyphenation' },
  'all-caps-body': { disposition: 'runs-declines', why: 'reads the transform and the character count' },
  'clipped-overflow-container': { disposition: 'runs-declines', why: 'reads overflow and position' },
  'unresolvable-font-size': {
    disposition: 'runs-declines',
    why: 'it reports the declaration the reducer refused; the sheet is not applied under one, so the report is the same on both sides',
  },
  'broken-image': {
    disposition: 'runs-declines',
    why: 'the engine control every page here carries; it is asserted present on every page rather than graded, and is filtered out of the takes',
  },

  // --- the rules this engine cannot run at all -----------------------------
  'line-length': {
    disposition: 'cannot-run',
    why: 'needs a layout rectangle, and the static engine passes none',
  },
  'body-text-viewport-edge': {
    disposition: 'cannot-run',
    why: 'needs a layout rectangle and a viewport, and the static engine has neither',
  },
  'gpt-thin-border-wide-shadow': {
    disposition: 'cannot-run',
    why: 'gated behind an option this sweep does not pass',
  },
};

/**
 * @param {Shape} shape
 * @param {string} tag
 * @returns {string}
 */
function pageHtml(shape, tag) {
  const body = shape.body
    .replace(/%T%/g, tag)
    .replace(/%OPEN%/g, `<${tag}>`)
    .replace(/%CLOSE%/g, `</${tag}>`);
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>' +
    `<style>${shape.style ?? ''}</style></head><body>${body}<img src=""></body></html>`
  );
}

export { SHAPES, SUBJECTS, DISPOSITIONS, pageHtml };
