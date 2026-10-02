import fs from 'node:fs';
import path from 'node:path';

import { finding } from './findings.mjs';
import { GENERIC_FONTS } from './shared/constants.mjs';
import { parseAnyColor } from './shared/color.mjs';
import { resolveLengthPx } from './shared/length.mjs';
import {
  parseFrontmatter as parseYamlFrontmatter,
  unquoteYamlKey,
} from '../lib/yaml-frontmatter.mjs';

const DESIGN_NAMES = ['DESIGN.md', 'Design.md', 'design.md'];
const FALLBACK_DIRS = ['.agents/context', 'docs'];
const COLOR_CHANNEL_TOLERANCE = 6;
const RADIUS_TOLERANCE_PX = 0.5;

const CSS_COLOR_RE = /#[0-9a-f]{3,8}\b|rgba?\([^)]+\)|oklch\([^)]+\)|hsla?\([^)]+\)/gi;
const FONT_DECL_RE = /font-family\s*:\s*([^;}\n]+)/gi;
const FONT_JS_RE = /fontFamily\s*[:=]\s*["'`]([^"'`]+)["'`]/g;
const GOOGLE_FONT_RE = /fonts\.googleapis\.com\/css2?\?[^"'\s)<>]*/gi;
const BORDER_RADIUS_RE = /border-radius\s*:\s*([^;}\n]+)/gi;
const BORDER_RADIUS_JS_RE = /borderRadius\s*[:=]\s*["'`]([^"'`]+)["'`]/g;

/**
 * The declared design system a scan is held to: the fonts, colours and radii a
 * document names, with a flag per kind saying whether the document declared it.
 * @typedef {{
 *   present: boolean,
 *   sourcePath: string | null,
 *   sidecarPath: string | null,
 *   mdNewerThanJson: boolean,
 *   allowedFonts: Set<string>,
 *   allowedColorKeys: Map<string, { color: Rgb, labels: string[] }>,
 *   allowedRadii: { name: string, value: string, px: number }[],
 *   hasPillRadius: boolean,
 *   hasFonts?: boolean,
 *   hasColors?: boolean,
 *   hasRadii?: boolean,
 * }} DesignSystem
 */

/** @typedef {import('./shared/color.mjs').Rgb} Rgb */
/** @typedef {import('./findings.mjs').Finding & { ignoreValue?: string, value?: string }} DesignFinding */
/** @typedef {import('./engines/static-html/css-cascade.mjs').StaticElement} ElementLike */

const STATIC_DESIGN_SKIP_TAGS = new Set(['head', 'title', 'meta', 'link', 'style', 'script', 'noscript', 'template', 'source']);

/**
 * @param {string} dir
 * @param {readonly string[]} names
 * @returns {string | null}
 */
function firstExisting(dir, names) {
  for (const name of names) {
    const abs = path.join(dir, name);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function resolveDesignMdPath(cwd = process.cwd()) {
  const root = firstExisting(cwd, DESIGN_NAMES);
  if (root) return { path: root, contextDir: cwd };

  for (const rel of FALLBACK_DIRS) {
    const dir = path.resolve(cwd, rel);
    const found = firstExisting(dir, DESIGN_NAMES);
    if (found) return { path: found, contextDir: dir };
  }

  return null;
}

function resolveDesignSidecarPath(cwd = process.cwd(), contextDir = cwd) {
  const candidates = [
    path.join(cwd, '.impeccable', 'design.json'),
    path.join(cwd, 'DESIGN.json'),
    path.join(contextDir, 'DESIGN.json'),
  ];
  return candidates.find((candidate, index) =>
    candidates.indexOf(candidate) === index && fs.existsSync(candidate)
  ) || null;
}

// The shared reader returns the body too; this module only wants the tokens.
/** @param {string} md */
function parseFrontmatter(md) {
  return parseYamlFrontmatter(md).frontmatter;
}

/**
 * @param {string | null | undefined} filePath
 * @returns {Record<string, unknown> | null}
 */
function safeReadJson(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function normalizeFontName(value) {
  return String(value || '')
    .trim()
    .replace(/\s*!important\s*$/i, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * @param {unknown} stack
 * @returns {string[]}
 */
function splitFontStack(stack) {
  return String(stack || '')
    .replace(/\s*!important\s*$/i, '')
    .split(',')
    .map(normalizeFontName)
    .filter(Boolean);
}

/** @param {string | null | undefined} stack */
function primaryFont(stack) {
  if (!stack || /var\(/i.test(stack) || !isLiteralFontStack(stack)) return '';
  return splitFontStack(stack).find(font => !GENERIC_FONTS.has(font)) || '';
}

/** @param {unknown} stack */
function isLiteralFontStack(stack) {
  const text = String(stack || '');
  return !/[$`{}]|\s\+\s|\|\|/.test(text);
}

/** @param {unknown} raw */
function cssColorLabel(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

/** @param {Rgb | null | undefined} color */
function colorKey(color) {
  if (!color) return '';
  return `${color.r},${color.g},${color.b}`;
}

/**
 * @param {Rgb | null | undefined} a
 * @param {Rgb | null | undefined} b
 */
function colorsClose(a, b) {
  if (!a || !b) return false;
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.g - b.g),
    Math.abs(a.b - b.b),
  ) <= COLOR_CHANNEL_TOLERANCE;
}

/**
 * @param {number} H
 * @param {number} S
 * @param {number} L
 * @param {number} [alpha]
 * @returns {Rgb}
 */
function hslToRgb(H, S, L, alpha = 1) {
  const h = (((H % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(1, S));
  const l = Math.max(0, Math.min(1, L));
  /**
   * @param {number} p
   * @param {number} q
   * @param {number} t
   */
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    a: alpha,
  };
}

/**
 * @param {unknown} value
 * @returns {Rgb | null}
 */
function parseDesignColor(value) {
  const text = String(value || '').trim();
  const parsed = parseAnyColor(text);
  if (parsed) return parsed;
  const hsl = text.match(/hsla?\(\s*([-\d.]+)(?:deg)?\s*,?\s*([\d.]+)%\s*,?\s*([\d.]+)%(?:\s*[,/]\s*([\d.]+))?\s*\)/i);
  if (hsl) {
    return hslToRgb(
      parseFloat(/** @type {string} */ (hsl[1])),
      parseFloat(/** @type {string} */ (hsl[2])) / 100,
      parseFloat(/** @type {string} */ (hsl[3])) / 100,
      hsl[4] !== undefined ? parseFloat(hsl[4]) : 1,
    );
  }
  return null;
}

/**
 * @param {DesignSystem} out
 * @param {unknown} value
 * @param {string} label
 */
function addDesignColor(out, value, label) {
  const parsed = parseDesignColor(value);
  if (!parsed) return;
  const key = colorKey(parsed);
  if (!out.allowedColorKeys.has(key)) {
    out.allowedColorKeys.set(key, { color: parsed, labels: [] });
  }
  /** @type {{ labels: string[] }} */ (out.allowedColorKeys.get(key)).labels.push(
    label || cssColorLabel(value)
  );
}

/**
 * @param {DesignSystem} out
 * @param {unknown} colors
 * @param {string} [prefix]
 */
function addColorObject(out, colors, prefix = 'colors') {
  if (!colors || typeof colors !== 'object') return;
  for (const [name, value] of Object.entries(colors)) {
    if (typeof value === 'string') {
      addDesignColor(out, value, `${prefix}.${name}`);
    }
  }
}

/**
 * The value as a keyed record, or null when it is not one. The frontmatter and
 * the JSON sidecar arrive from a parser that promises nothing about their
 * shape, so every hop through them establishes its own before reading on.
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object'
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {DesignSystem} out
 * @param {Record<string, unknown> | null} sidecar
 */
function addSidecarColors(out, sidecar) {
  const colorMeta = asRecord(asRecord(sidecar?.['extensions'])?.['colorMeta']);
  if (!colorMeta) return;

  for (const [name, rawMeta] of Object.entries(colorMeta)) {
    const meta = asRecord(rawMeta);
    if (!meta) continue;
    const canonical = meta['canonical'];
    if (typeof canonical === 'string') addDesignColor(out, canonical, `sidecar.${name}`);
    const tonalRamp = meta['tonalRamp'];
    if (Array.isArray(tonalRamp)) {
      for (const [index, value] of tonalRamp.entries()) {
        if (typeof value === 'string') addDesignColor(out, value, `sidecar.${name}.tonalRamp[${index}]`);
      }
    }
  }
}

/**
 * @param {DesignSystem} out
 * @param {unknown} typography
 */
function addTypographyFonts(out, typography) {
  if (!typography || typeof typography !== 'object') return;
  for (const role of Object.values(typography)) {
    if (!role || typeof role !== 'object') continue;
    if (typeof role.fontFamily !== 'string') continue;
    for (const font of splitFontStack(role.fontFamily)) {
      if (!GENERIC_FONTS.has(font)) out.allowedFonts.add(font);
    }
  }
}

/**
 * @param {DesignSystem} out
 * @param {unknown} rounded
 */
function addRoundedScale(out, rounded) {
  if (!rounded || typeof rounded !== 'object') return;
  for (const [rawName, value] of Object.entries(rounded)) {
    const name = unquoteYamlKey(rawName).toLowerCase();
    addRoundedToken(out, name, value);
  }
}

/**
 * @param {DesignSystem} out
 * @param {string} name
 * @param {unknown} value
 */
function addRoundedToken(out, name, value) {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const raw = String(value).trim();
  if (!raw || /var\(/i.test(raw) || raw.includes('%')) return;
  const px = resolveLengthPx(raw, 16);
  if (px == null || !Number.isFinite(px)) return;
  out.allowedRadii.push({ name, value: raw, px });
  if (/(^|\.)(full|pill|round|rounded-full)$/.test(name)) out.hasPillRadius = true;
}

/**
 * @param {DesignSystem} out
 * @param {Record<string, unknown> | null} sidecar
 */
function addSidecarRadii(out, sidecar) {
  const roundedMeta = asRecord(asRecord(sidecar?.['extensions'])?.['roundedMeta']);
  if (!roundedMeta) return;

  for (const [rawName, rawMeta] of Object.entries(roundedMeta)) {
    const name = unquoteYamlKey(rawName).toLowerCase();
    if (typeof rawMeta === 'string' || typeof rawMeta === 'number') {
      addRoundedToken(out, `sidecar.${name}`, rawMeta);
      continue;
    }
    const meta = asRecord(rawMeta);
    if (!meta) continue;
    for (const key of ['canonical', 'value']) {
      const value = meta[key];
      if (typeof value === 'string' || typeof value === 'number') {
        addRoundedToken(out, `sidecar.${name}.${key}`, value);
      }
    }
    for (const key of ['values', 'aliases']) {
      const list = meta[key];
      if (!Array.isArray(list)) continue;
      for (const [index, value] of list.entries()) {
        addRoundedToken(out, `sidecar.${name}.${key}[${index}]`, value);
      }
    }
    if (
      /^(full|pill|round|rounded-full)$/.test(name) ||
      /^(full|pill|round)$/i.test(String(meta['role'] || ''))
    ) {
      out.hasPillRadius = true;
    }
  }
}

/**
 * @param {{ frontmatter?: Record<string, unknown> | null, sidecar?: Record<string, unknown> | null, sourcePath?: string | null, sidecarPath?: string | null, mdNewerThanJson?: boolean }} [input]
 * @returns {DesignSystem}
 */
function normalizeDesignSystem(input = {}) {
  const frontmatter = input.frontmatter || {};
  const sidecar = input.sidecar || null;
  /** @type {DesignSystem} */
  const out = {
    present: true,
    sourcePath: input.sourcePath || null,
    sidecarPath: input.sidecarPath || null,
    mdNewerThanJson: input.mdNewerThanJson === true,
    allowedFonts: new Set(),
    allowedColorKeys: new Map(),
    allowedRadii: [],
    hasPillRadius: false,
  };

  addTypographyFonts(out, frontmatter['typography']);
  addColorObject(out, frontmatter['colors']);
  addSidecarColors(out, sidecar);
  addRoundedScale(out, frontmatter['rounded']);
  addSidecarRadii(out, sidecar);

  out.hasFonts = out.allowedFonts.size > 0;
  out.hasColors = out.allowedColorKeys.size > 0;
  out.hasRadii = out.allowedRadii.length > 0;
  return out;
}

function loadDesignSystemForCwd(cwd = process.cwd()) {
  const md = resolveDesignMdPath(cwd);
  if (!md) return null;

  let frontmatter = null;
  let mdStat = null;
  try {
    mdStat = fs.statSync(md.path);
    frontmatter = parseFrontmatter(fs.readFileSync(md.path, 'utf-8'));
  } catch {
    return null;
  }
  if (!frontmatter || typeof frontmatter !== 'object') return null;

  const sidecarPath = resolveDesignSidecarPath(cwd, md.contextDir);
  const sidecar = safeReadJson(sidecarPath);
  let sidecarStat = null;
  try {
    if (sidecarPath) sidecarStat = fs.statSync(sidecarPath);
  } catch {
    sidecarStat = null;
  }

  return normalizeDesignSystem({
    frontmatter,
    sidecar,
    sourcePath: md.path,
    sidecarPath,
    mdNewerThanJson: !!(mdStat && sidecarStat && mdStat.mtimeMs > sidecarStat.mtimeMs + 1000),
  });
}

/**
 * @param {string} font
 * @param {DesignSystem | null | undefined} designSystem
 */
function isAllowedFont(font, designSystem) {
  if (!font || GENERIC_FONTS.has(font)) return true;
  if (!designSystem?.hasFonts) return true;
  return designSystem.allowedFonts.has(font);
}

/**
 * @param {unknown} raw
 * @param {DesignSystem | null | undefined} designSystem
 */
function isAllowedColorRaw(raw, designSystem) {
  if (!designSystem?.hasColors) return true;
  const text = String(raw || '').trim().toLowerCase();
  if (!text || text === 'transparent' || text === 'currentcolor' || text === 'inherit' || text === 'initial') return true;
  if (text.includes('var(')) return true;
  const parsed = parseDesignColor(text);
  if (!parsed) return true;
  if ((parsed.a ?? 1) <= 0.05) return true;
  for (const entry of designSystem.allowedColorKeys.values()) {
    if (colorsClose(parsed, entry.color)) return true;
  }
  return false;
}

/**
 * @param {unknown} raw
 * @param {DesignSystem | null | undefined} designSystem
 */
function isAllowedRadiusRaw(raw, designSystem) {
  if (!designSystem?.hasRadii) return true;
  const text = String(raw || '').trim().toLowerCase();
  if (!text || text === '0' || text === 'none' || text === 'initial' || text === 'inherit') return true;
  if (text.includes('var(') || text.includes('%')) return true;
  const px = resolveLengthPx(text, 16);
  if (px == null || !Number.isFinite(px) || px <= RADIUS_TOLERANCE_PX) return true;
  if (designSystem.hasPillRadius && px >= 99) return true;
  return designSystem.allowedRadii.some(entry => Math.abs(entry.px - px) <= RADIUS_TOLERANCE_PX);
}

/** @param {unknown} line */
function lineLooksCommented(line) {
  const trimmed = String(line || '').trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('<!--');
}

/**
 * @param {string} line
 * @param {RegExpMatchArray} match
 */
function isProbablyColorLiteral(line, match) {
  const raw = match?.[0] || '';
  const index = match.index ?? -1;
  if (index < 0) return false;
  if (isInsideCssAttributeSelector(line, index)) return false;

  const before = line.slice(0, index);
  const after = line.slice(index + raw.length);

  if (raw.startsWith('#')) {
    if (before.endsWith('&')) return false; // HTML numeric entity, e.g. &#8596;

    const prevNonSpace = before.match(/\S(?=\s*$)/)?.[0] || '';
    const nextNonSpace = after.match(/^\s*(\S)/)?.[1] || '';
    if (prevNonSpace === '>' && nextNonSpace === '<') return false; // plain text, e.g. PR #155
  }

  const styleContext = /(?:^|[{\s;"'`(,])(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|fill|stroke)\s*:\s*[^;{}"'`]*/i.test(before);
  const cssFunctionContext = /(?:linear-gradient|radial-gradient|conic-gradient|color-mix)\([^)]*$/i.test(before);
  const jsColorKeyContext = /(?:^|[,{]\s*)(?:color|background|backgroundColor|borderColor|outlineColor|fill|stroke|boxShadow|textShadow)\s*[:=]\s*["'`]?[^"'`,}]*/i.test(before);

  return styleContext || cssFunctionContext || jsColorKeyContext;
}

/**
 * @param {string} line
 * @param {number} index
 */
function isInsideCssAttributeSelector(line, index) {
  if (index < 0) return false;
  const before = line.slice(0, index);
  const lastOpen = before.lastIndexOf('[');
  if (lastOpen === -1) return false;
  const lastClose = before.lastIndexOf(']');
  if (lastClose > lastOpen) return false;
  const after = line.slice(index);
  const close = after.indexOf(']');
  const block = after.indexOf('{');
  return close !== -1 && (block === -1 || close < block);
}

/**
 * @param {string} id
 * @param {string} filePath
 * @param {string} snippet
 * @param {number} [line]
 * @param {Record<string, unknown>} [extras]
 * @returns {DesignFinding}
 */
function makeDesignFinding(id, filePath, snippet, line = 0, extras = {}) {
  return { ...finding(id, filePath, snippet, line), ...extras };
}

/** @param {unknown} value */
function decodeGoogleFamily(value) {
  const family = /** @type {string} */ (String(value || '').split(':')[0]).replace(/\+/g, ' ');
  try {
    return decodeURIComponent(family);
  } catch {
    return family;
  }
}

/**
 * @param {string | undefined} stack
 * @param {string} filePath
 * @param {number} line
 * @param {DesignSystem} designSystem
 * @param {string} context
 * @returns {DesignFinding[]}
 */
function checkFontStack(stack, filePath, line, designSystem, context) {
  const primary = primaryFont(stack);
  if (!primary || isAllowedFont(primary, designSystem)) return [];
  const display = primary.replace(/\b\w/g, ch => ch.toUpperCase());
  return [makeDesignFinding(
    'design-system-font',
    filePath,
    `${context}: ${display} is not declared in DESIGN.md typography`,
    line,
    { ignoreValue: display },
  )];
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function extractRadiusTokens(value) {
  return String(value || '')
    .replace(/\s*\/\s*/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean);
}

/**
 * @param {string | undefined} value
 * @param {string} filePath
 * @param {number} line
 * @param {DesignSystem} designSystem
 * @param {string} context
 * @returns {DesignFinding[]}
 */
function checkRadiusValue(value, filePath, line, designSystem, context) {
  const findings = [];
  for (const token of extractRadiusTokens(value)) {
    if (isAllowedRadiusRaw(token, designSystem)) continue;
    findings.push(makeDesignFinding(
      'design-system-radius',
      filePath,
      `${context}: ${token} is outside the DESIGN.md rounded scale`,
      line,
      { ignoreValue: token },
    ));
  }
  return findings;
}

/**
 * @param {unknown} content
 * @param {string} filePath
 * @param {{ designSystem?: DesignSystem | null }} [options]
 * @returns {DesignFinding[]}
 */
function checkSourceDesignSystem(content, filePath, options = {}) {
  const designSystem = options.designSystem;
  if (!designSystem?.present) return [];

  /** @type {DesignFinding[]} */
  const findings = [];
  const lines = String(content || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = /** @type {string} */ (lines[i]);
    const lineNum = i + 1;
    if (lineLooksCommented(line)) continue;

    if (designSystem.hasFonts) {
      for (const match of line.matchAll(FONT_DECL_RE)) {
        findings.push(...checkFontStack(match[1], filePath, lineNum, designSystem, 'font-family'));
      }
      for (const match of line.matchAll(FONT_JS_RE)) {
        findings.push(...checkFontStack(match[1], filePath, lineNum, designSystem, 'fontFamily'));
      }
      for (const match of line.matchAll(GOOGLE_FONT_RE)) {
        const url = match[0];
        for (const familyMatch of url.matchAll(/[?&]family=([^&]+)/g)) {
          const font = normalizeFontName(decodeGoogleFamily(familyMatch[1]));
          if (!font || isAllowedFont(font, designSystem)) continue;
          const display = decodeGoogleFamily(familyMatch[1]);
          findings.push(makeDesignFinding(
            'design-system-font',
            filePath,
            `Google Fonts: ${display} is not declared in DESIGN.md typography`,
            lineNum,
            { ignoreValue: display },
          ));
        }
      }
    }

    if (designSystem.hasColors) {
      for (const match of line.matchAll(CSS_COLOR_RE)) {
        if (!isProbablyColorLiteral(line, match)) continue;
        const raw = cssColorLabel(match[0]);
        if (isAllowedColorRaw(raw, designSystem)) continue;
        findings.push(makeDesignFinding(
          'design-system-color',
          filePath,
          `Undocumented color ${raw} is outside DESIGN.md colors`,
          lineNum,
          { ignoreValue: raw },
        ));
      }
    }

    if (designSystem.hasRadii) {
      for (const match of line.matchAll(BORDER_RADIUS_RE)) {
        findings.push(...checkRadiusValue(match[1], filePath, lineNum, designSystem, 'border-radius'));
      }
      for (const match of line.matchAll(BORDER_RADIUS_JS_RE)) {
        findings.push(...checkRadiusValue(match[1], filePath, lineNum, designSystem, 'borderRadius'));
      }
    }
  }

  return dedupeDesignFindings(findings);
}

/** @param {ElementLike} el */
function hasDirectText(el) {
  return Array.from(el.childNodes || []).some(node => node.nodeType === 3 && node.textContent.trim().length > 0);
}

/** @param {ElementLike} el */
function sampleText(el) {
  const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
  return text ? ` "${text.slice(0, 40)}"` : '';
}

/**
 * @param {import('./engines/static-html/css-cascade.mjs').StaticDocument} document
 * @param {{ getComputedStyle: (el: ElementLike) => import('./engines/static-html/css-cascade.mjs').StaticStyle }} window
 * @param {string} filePath
 * @param {DesignSystem | null | undefined} designSystem
 * @returns {DesignFinding[]}
 */
function collectStaticDesignSystemFindings(document, window, filePath, designSystem) {
  if (!designSystem?.present) return [];
  /** @type {DesignFinding[]} */
  const findings = [];
  /** @type {Set<string>} */
  const seenFonts = new Set();
  /** @type {Set<string>} */
  const seenColors = new Set();
  /** @type {Set<string>} */
  const seenRadii = new Set();

  for (const el of document.querySelectorAll('*')) {
    if (shouldSkipStaticDesignElement(el, window)) continue;
    const tag = el.tagName?.toLowerCase?.() || 'unknown';
    const style = window.getComputedStyle(el);

    if (designSystem.hasFonts && hasDirectText(el)) {
      const font = primaryFont(style.fontFamily || '');
      if (font && !seenFonts.has(font) && !isAllowedFont(font, designSystem)) {
        seenFonts.add(font);
        findings.push(makeDesignFinding(
          'design-system-font',
          filePath,
          `${tag}${sampleText(el)} uses ${font}; not declared in DESIGN.md typography`,
          0,
          { ignoreValue: font },
        ));
      }
    }

    if (designSystem.hasColors) {
      const colorChecks = [];
      if (hasDirectText(el)) colorChecks.push(['text color', style.color]);
      if (!isTransparentCss(style.backgroundColor)) colorChecks.push(['background', style.backgroundColor]);
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const byProperty = /** @type {Record<string, string | undefined>} */ (
          /** @type {unknown} */ (style)
        );
        if ((parseFloat(byProperty[`border${side}Width`] ?? '') || 0) > 0) {
          colorChecks.push([`border-${side.toLowerCase()}`, byProperty[`border${side}Color`] ?? '']);
        }
      }
      if ((parseFloat(style.outlineWidth) || 0) > 0) colorChecks.push(['outline', style.outlineColor]);

      for (const [kind, raw] of colorChecks) {
        const label = cssColorLabel(raw);
        if (isAllowedColorRaw(label, designSystem)) continue;
        const key = `${kind}:${label}`;
        if (seenColors.has(key)) continue;
        seenColors.add(key);
        findings.push(makeDesignFinding(
          'design-system-color',
          filePath,
          `${kind} ${label} on ${tag}${sampleText(el)} is outside DESIGN.md colors`,
          0,
          { ignoreValue: label },
        ));
      }
    }

    if (designSystem.hasRadii) {
      const rawRadius = String(style.borderRadius || '').trim();
      if (!rawRadius) continue;
      for (const token of extractRadiusTokens(rawRadius)) {
        if (isAllowedRadiusRaw(token, designSystem)) continue;
        if (seenRadii.has(token)) continue;
        seenRadii.add(token);
        findings.push(makeDesignFinding(
          'design-system-radius',
          filePath,
          `border-radius ${token} on ${tag}${sampleText(el)} is outside the DESIGN.md rounded scale`,
          0,
          { ignoreValue: token },
        ));
      }
    }
  }

  return findings;
}

/**
 * @param {ElementLike} el
 * @param {{ getComputedStyle: (el: ElementLike) => import('./engines/static-html/css-cascade.mjs').StaticStyle }} window
 */
function shouldSkipStaticDesignElement(el, window) {
  const tag = el.tagName?.toLowerCase?.() || '';
  if (STATIC_DESIGN_SKIP_TAGS.has(tag)) return true;

  let current = el;
  while (current) {
    if (current.getAttribute?.('hidden') !== null || current.getAttribute?.('aria-hidden') === 'true') return true;
    const style = window.getComputedStyle(current);
    const display = String(style.display || '').toLowerCase();
    const visibility = String(style.visibility || '').toLowerCase();
    if (display === 'none' || visibility === 'hidden' || visibility === 'collapse') return true;
    current = current.parentElement;
  }
  return false;
}

/** @param {unknown} value */
function isTransparentCss(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text === 'transparent') return true;
  const parsed = parseDesignColor(text);
  return parsed ? (parsed.a ?? 1) <= 0.05 : false;
}

/**
 * @param {DesignFinding | null | undefined} item
 * @returns {string | null}
 */
function canonicalDesignFindingKey(item) {
  if (!item?.antipattern?.startsWith?.('design-system-')) return null;
  const value = item.ignoreValue || item.value || '';
  if (item.antipattern === 'design-system-font') {
    const context = /google fonts/i.test(item.snippet || '') ? 'google-font' : 'font';
    const font = normalizeFontName(value);
    return font ? `${item.antipattern}:${context}:${font}` : null;
  }
  if (item.antipattern === 'design-system-color') {
    const parsed = parseDesignColor(value);
    if (parsed) return `${item.antipattern}:color:${colorKey(parsed)}`;
    const label = cssColorLabel(value).toLowerCase();
    return label ? `${item.antipattern}:color:${label}` : null;
  }
  if (item.antipattern === 'design-system-radius') {
    const px = resolveLengthPx(String(value || '').trim(), 16);
    if (px != null && Number.isFinite(px)) return `${item.antipattern}:radius:${Math.round(px * 100) / 100}`;
    const label = String(value || '').trim().toLowerCase();
    return label ? `${item.antipattern}:radius:${label}` : null;
  }
  return null;
}

/**
 * @param {(readonly DesignFinding[] | null | undefined)[]} groups
 * @returns {DesignFinding[]}
 */
function mergeDesignSystemFindings(...groups) {
  /** @type {DesignFinding[]} */
  const out = [];
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const group of groups) {
    for (const item of group || []) {
      const key = canonicalDesignFindingKey(item);
      if (key) {
        if (seen.has(key)) {
          const existing = /** @type {DesignFinding} */ (
            out[/** @type {number} */ (seen.get(key))]
          );
          if ((existing.line || 0) <= 0 && (item.line || 0) > 0) existing.line = item.line;
          continue;
        }
        seen.set(key, out.length);
      }
      out.push(item);
    }
  }
  return out;
}

/**
 * @param {readonly DesignFinding[]} findings
 * @returns {DesignFinding[]}
 */
function dedupeDesignFindings(findings) {
  /** @type {DesignFinding[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of findings) {
    const key = [
      item.antipattern,
      item.line || 0,
      normalizeFontName(item.ignoreValue || item.snippet || ''),
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export {
  parseFrontmatter,
  normalizeDesignSystem,
  loadDesignSystemForCwd,
  isAllowedFont,
  isAllowedColorRaw,
  isAllowedRadiusRaw,
  checkSourceDesignSystem,
  collectStaticDesignSystemFindings,
  mergeDesignSystemFindings,
};
