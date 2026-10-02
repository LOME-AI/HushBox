import fs from 'node:fs';
import path from 'node:path';

import { GENERIC_FONTS, OVERUSED_FONTS, TEXT_ELEMENT_SELECTOR } from '../../shared/constants.mjs';
import {
  checkSourceDesignSystem,
  collectStaticDesignSystemFindings,
  mergeDesignSystemFindings,
} from '../../design-system.mjs';
import { SCOPE_DOCUMENT, reportableOnSource } from '../../shared/page.mjs';
import { applyInlineIgnores } from '../../shared/inline-ignores.mjs';
import { ENGINE_STATIC_HTML, finding, stampEngine } from '../../findings.mjs';
import {
  checkElementBorders,
  checkElementClippedOverflow,
  checkElementColors,
  checkElementGlow,
  checkElementGptBorderShadow,
  checkElementHeroEyebrow,
  checkElementIconTile,
  checkElementItalicSerif,
  checkElementMotion,
  checkElementOversizedH1,
  checkElementQuality,
  checkFlatTypeHierarchy,
  checkUnresolvableFontSizes,
  checkCreamPalette,
  checkHtmlPatterns,
  checkPageLayout,
  checkPageQualityFromDoc,
  checkRepeatedSectionKickersFromDoc,
  resolveBackground,
  resolveBorderRadiusPx,
} from '../../rules/checks.mjs';
import { filterByProviders } from '../../registry/antipatterns.mjs';
import { detectText, runTextContentAnalyzers } from '../regex/detect-text.mjs';
import {
  StaticDocument,
  buildStaticStyleMap,
  buildStaticWindow,
  collectStaticCssText,
} from './css-cascade.mjs';


/** @typedef {import('../../rules/checks.mjs').ElementLike} ElementLike */
/** @typedef {import('../../rules/checks.mjs').StyleLike} StyleLike */
/** @typedef {import('../../rules/checks.mjs').WindowLike} WindowLike */
/** @typedef {import('../../rules/checks.mjs').WindowWithDocument} WindowWithDocument */
/** @typedef {import('../../rules/checks.mjs').RuleFinding} RuleFinding */
/** @typedef {import('../../findings.mjs').Finding} Finding */

/**
 * One element rule as the static engine drives it: the selector it visits, and
 * the call it makes for each match. The parameter list is fixed, so a rule that
 * needs none of the later arguments still declares them.
 * @typedef {{ id: string, selector: string, run: (el: ElementLike, tag: string, style: StyleLike, window: WindowWithDocument, customPropMap: Map<string, string> | null) => readonly RuleFinding[] }} StaticElementRule
 */

/**
 * @param {import('./css-cascade.mjs').StaticDocument} document
 * @param {WindowLike} window
 * @returns {RuleFinding[]}
 */
function checkStaticPageTypography(document, window) {
  /** @type {RuleFinding[]} */
  const findings = [];
  /** @type {Set<string>} */
  const fonts = new Set();
  /** @type {Set<string>} */
  const overusedFound = new Set();
  for (const el of document.querySelectorAll(TEXT_ELEMENT_SELECTOR)) {
    const hasText = el.childNodes.some(
      (/** @type {{ nodeType: number, textContent?: string | null }} */ node) =>
        node.nodeType === 3 && (node.textContent ?? '').trim().length > 0
    );
    if (!hasText) continue;
    const ff = window.getComputedStyle(el).fontFamily || '';
    const stack = ff.split(',').map((family) => family.trim().replace(/^['"]|['"]$/g, '').toLowerCase());
    const primary = stack.find((family) => family && !GENERIC_FONTS.has(family));
    if (!primary) continue;
    fonts.add(primary);
    if (OVERUSED_FONTS.has(primary)) overusedFound.add(primary);
  }
  // Which face an element is set in is read off that element, so the answer is
  // the same whether the source is a page or one component cut out of it.
  for (const font of overusedFound) {
    findings.push({ id: 'overused-font', snippet: `Primary font: ${font}` });
  }
  // Whether a page settles on one face is not: a component using a single face
  // says nothing about the page it sits in.
  if (fonts.size === 1 && document.querySelectorAll('*').length >= 20) {
    findings.push({
      id: 'single-font',
      scope: SCOPE_DOCUMENT,
      snippet: `only font used is ${[...fonts][0]}`,
    });
  }
  findings.push(...checkFlatTypeHierarchy(document, window));
  return findings;
}

/**
 * @param {ElementLike} el
 * @returns {RuleFinding[]}
 */
function checkElementBrokenImage(el) {
  const src =
    (el.getAttribute && el.getAttribute('src')) ??
    /** @type {{ attribs?: Record<string, string> }} */ (el).attribs?.['src'];
  // Missing src attribute entirely
  if (src === undefined || src === null) {
    return [{ id: 'broken-image', snippet: '<img> with no src attribute' }];
  }
  const trimmed = String(src).trim();
  // Empty or placeholder-only src values
  if (trimmed === '' || trimmed === '#') {
    return [{ id: 'broken-image', snippet: `<img src="${src}">` }];
  }
  return [];
}

/** @type {readonly StaticElementRule[]} */
const STATIC_ELEMENT_RULES = [
  { id: 'border-rules', selector: '*', run: (el, tag, style, window, _customPropMap) => checkElementBorders(tag, style, null, resolveBorderRadiusPx(el, style, parseFloat(style.width) || 0, window)) },
  { id: 'color-rules', selector: '*', run: (el, tag, style, window, customPropMap) => checkElementColors(el, style, tag, window, customPropMap, false) },
  { id: 'dark-glow', selector: '*', run: (el, tag, style, window, customPropMap) => checkElementGlow(tag, style, resolveBackground(el.parentElement || el, window, customPropMap)) },
  { id: 'motion-rules', selector: '*', run: (el, tag, style) => checkElementMotion(el, tag, style) },
  { id: 'icon-tile-stack', selector: 'h1,h2,h3,h4,h5,h6', run: (el, tag, _style, window) => checkElementIconTile(el, tag, window) },
  { id: 'italic-serif-display', selector: 'h1,h2', run: (el, tag, style, window) => checkElementItalicSerif(el, style, tag, window) },
  { id: 'hero-eyebrow-chip', selector: 'h1', run: (el, tag, style, window, customPropMap) => checkElementHeroEyebrow(el, style, tag, window, customPropMap) },
  { id: 'broken-image', selector: 'img', run: (el) => checkElementBrokenImage(el) },
  { id: 'quality-rules', selector: '*', run: (el, tag, style, window) => checkElementQuality(el, style, tag, window) },
  { id: 'oversized-h1', selector: 'h1', run: (el, tag, style, window) => checkElementOversizedH1(el, style, tag, window) },
  { id: 'clipped-overflow-container', selector: '*', run: (el, tag, style, window) => checkElementClippedOverflow(el, style, tag, window) },
  { id: 'gpt-thin-border-wide-shadow', selector: '*', run: (el, _tag, style) => checkElementGptBorderShadow(el, style) },
];

/**
 * @param {string} filePath
 * @param {{ designSystem?: import('../../design-system.mjs').DesignSystem, providers?: readonly string[], inlineIgnores?: boolean }} [options]
 * @returns {Promise<Finding[]>}
 */
async function detectHtml(filePath, options = {}) {
  const html = fs.readFileSync(filePath, 'utf-8');
  /** @type {(text: string, options?: unknown) => import('./css-cascade.mjs').DomNode} */
  let parseDocument;

  /** @type {import('./css-cascade.mjs').StaticModules} */
  let modules;
  try {
    const [htmlparser2, cssSelect, csstree, domutils] = await Promise.all([
      import('htmlparser2'),
      import('css-select'),
      import('css-tree'),
      import('domutils'),
    ]);
    parseDocument = /** @type {(text: string, options?: unknown) => import('./css-cascade.mjs').DomNode} */ (
      /** @type {unknown} */ (htmlparser2.parseDocument)
    );
    modules = {
      selectAll: cssSelect.selectAll,
      selectOne: cssSelect.selectOne,
      is: cssSelect.is,
      csstree: /** @type {import('./css-cascade.mjs').CssTree} */ (
        /** @type {unknown} */ (csstree)
      ),
      domutils: /** @type {{ textContent: (node: import('./css-cascade.mjs').DomNode) => string }} */ (
        /** @type {unknown} */ (domutils)
      ),
    };
  } catch {
    // The parser dependencies are unavailable, so this call runs the regex
    // engine instead. Returning its result unaltered is what makes the engine
    // stamp truthful: `detectText` stamps its own output, so a finding from
    // this path names the engine that actually ran, not the one asked for.
    return detectText(html, filePath, options);
  }

  const resolvedPath = path.resolve(filePath);
  const fileDir = path.dirname(resolvedPath);
  // The parse folds every attribute name to lower case, which is the one point
  // every reader of the document is downstream of: this module's lookups, and
  // the selector engine's, which reads `class`, `id` and every `[attr]` by the
  // lower-case name it folds a selector's to. Preserving the camelCased SVG
  // spellings an HTML parse restores would leave every one of those readers to
  // fold for itself, and no reader here names an attribute by any spelling but
  // the canonical lower-case one.
  const root = parseDocument(html, { lowerCaseAttributeNames: true, lowerCaseTags: true });

  const cssText = collectStaticCssText(root, fileDir, modules);
  const document = new StaticDocument(root, modules);
  buildStaticStyleMap(root, document, cssText, modules);
  const window = buildStaticWindow(document);

  /** @type {Map<string, string> | null} */
  const customPropMap = null;

  /** @type {Finding[]} */
  const findings = [];
  for (const rule of STATIC_ELEMENT_RULES) {
    const elements = document.querySelectorAll(rule.selector);
    for (const el of elements) {
      const tag = el.tagName.toLowerCase();
      const style = window.getComputedStyle(el);
      for (const f of rule.run(el, tag, style, window, customPropMap)) {
        findings.push(finding(f.id, filePath, f.snippet));
      }
    }
  }

  // Read off the element population the element rules walk. This report is what
  // {@link checkElementColors} stands down onto, so its population must be no
  // narrower than that rule's on either axis — the elements it visits, and the
  // sources it runs on at all. The second axis is what the page gate decides,
  // and this verdict declares no document scope for that reason: a source
  // carrying no doctype, no `<html>` and no `<head>` is exactly where component
  // code lives, and the rule it explains stands down on those too.
  for (const f of checkUnresolvableFontSizes(document, window)) {
    findings.push(finding(f.id, filePath, f.snippet));
  }

  if (options?.designSystem) {
    const sourceDesignFindings = checkSourceDesignSystem(html, filePath, { designSystem: options.designSystem });
    const staticDesignFindings = collectStaticDesignSystemFindings(document, window, filePath, options.designSystem);
    findings.push(...mergeDesignSystemFindings(staticDesignFindings, sourceDesignFindings));
  }

  // The passes that read the parsed document rather than one element at a time.
  // Every one of them runs on every source; what a source of component shape
  // may carry is decided afterwards, by each verdict's own declared scope, so
  // there is no longer a place in this control flow a rule can be gated by
  // being written inside it.
  for (const f of reportableOnSource(html, [
    ...checkStaticPageTypography(document, window),
    ...checkRepeatedSectionKickersFromDoc(document, window),
    ...checkPageLayout(document, window),
    ...checkCreamPalette(document, window),
    ...checkPageQualityFromDoc(document),
    // Both excluded ids are the two {@link checkElementMotion} already reads
    // off a resolved element, so what this drops is the weaker regex-on-source
    // copy of a verdict the element rules have made. That is a question about
    // duplicate verdicts rather than about page shape, which is why it is
    // answered here and not by a scope declaration — and it is answered for
    // these two ids only: {@link checkElementColors} reports `gradient-text`
    // and `ai-color-palette` from the same resolved cascade, and their copies
    // here are not dropped, so a source carrying either in raw CSS text is
    // reported twice.
    ...checkHtmlPatterns(html).filter(item =>
      item.id !== 'bounce-easing' && item.id !== 'layout-transition'
    ),
  ])) {
    findings.push(finding(f.id, filePath, f.snippet));
  }

  // Text-content analyzers (em-dash overuse, marketing buzzwords, numbered
  // section markers, aphoristic cadence) live in the regex engine. Call them
  // from here so .html files get the same coverage as .css/.tsx files. These
  // are scoped to text content only and don't overlap with static-html's
  // element/page rules. Each of the four declares the scope its verdict claims,
  // and {@link runTextContentAnalyzers} holds it to that declaration before it
  // returns — so what arrives here is already gated, which is why this call site
  // adds no scope declaration and why a component source answers the same
  // whichever engine reached these four.
  for (const f of runTextContentAnalyzers(html, filePath)) {
    findings.push(finding(f.antipattern, filePath, f.snippet));
  }

  const byProvider = filterByProviders(findings, options.providers);
  // Static-HTML findings carry no line number, so only whole-file
  // `impeccable-disable` directives apply here — exactly the standalone-document
  // waiver this primitive targets. Bypassed by `--no-config` / `--no-inline-ignores`.
  const reported = options?.inlineIgnores === false ? byProvider : applyInlineIgnores(byProvider, html);
  return stampEngine(reported, ENGINE_STATIC_HTML);
}

export { checkStaticPageTypography, STATIC_ELEMENT_RULES, detectHtml };
