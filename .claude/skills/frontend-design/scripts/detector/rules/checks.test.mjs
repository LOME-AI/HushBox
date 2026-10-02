/**
 * `cramped-padding`'s background-boundary precondition.
 *
 * The rule fires only when the element has a boundary a reader can see: two or
 * more borders, or a background that differs from the nearest non-transparent
 * ancestor background. The background-difference half is the one worth pinning
 * — an element painted the same colour as its parent has no visible edge, so
 * zero padding against that edge is invisible and must not be reported.
 *
 * Run these on their own with `node --test` from the repository root.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { makeStaticStyle } from '../engines/static-html/css-cascade.mjs';

import { checkQuality } from './checks.mjs';

/** @typedef {import('./checks.mjs').ElementLike} ElementLike */

const WHITE = 'rgb(255, 255, 255)';
const GREY = 'rgb(240, 240, 240)';

/** A computed style with no borders, no padding, and the given background. */
function styleWith(/** @type {string} */ backgroundColor) {
  return makeStaticStyle({
    backgroundColor,
    borderTopWidth: '0px',
    borderRightWidth: '0px',
    borderBottomWidth: '0px',
    borderLeftWidth: '0px',
    paddingTop: '0px',
    paddingRight: '0px',
    paddingBottom: '0px',
    paddingLeft: '0px',
  });
}

/**
 * A paragraph carrying its own text inside a single parent painted
 * `parentBackground`, run through the element-level quality rules.
 *
 * The stand-ins carry only the members `checkQuality` reads off an element on
 * this path — a real `StaticElement` needs a parsed document behind it, and
 * building one would put the HTML parser between this assertion and the rule
 * it is about.
 */
function findingIds(
  /** @type {string} */ elementBackground,
  /** @type {string} */ parentBackground
) {
  const parent = /** @type {ElementLike} */ (
    /** @type {unknown} */ ({ id: '', parentElement: null, children: [], childNodes: [] })
  );
  const el = /** @type {ElementLike} */ (
    /** @type {unknown} */ ({ id: '', parentElement: parent, children: [], childNodes: [] })
  );
  const parentStyle = styleWith(parentBackground);
  return checkQuality({
    el,
    tag: 'p',
    style: styleWith(elementBackground),
    hasDirectText: true,
    textLen: 40,
    fontSize: 16,
    lineHeightPx: 24,
    letterSpacingPx: 0,
    rect: { top: 0, right: 200, bottom: 40, left: 0, width: 200, height: 40 },
    win: { getComputedStyle: () => parentStyle },
  }).map((finding) => finding.id);
}

test('an element painted its parent colour has no visible boundary to be cramped against', () => {
  assert.deepEqual(findingIds(WHITE, WHITE), []);
});

test('an element painted a different colour from its parent is cramped against that boundary', () => {
  assert.deepEqual(findingIds(WHITE, GREY), ['cramped-padding']);
});
