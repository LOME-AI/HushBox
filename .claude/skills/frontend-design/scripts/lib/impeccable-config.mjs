/**
 * CLI-side reader/writer for the unified `.impeccable` config.
 *
 * This is a standalone HushBox copy: it owns the config-path layout, detector
 * ignore semantics, and the `.git/info/exclude` handling outright. There is no
 * upstream module to track — change the schema, ignore filtering, and exclude
 * marker here directly.
 *
 * Schema (config.json shared / config.local.json gitignored, per-developer):
 *   {
 *     "detector": { "ignoreRules": [], "ignoreFiles": [], "ignoreValues": [], "designSystem": { "enabled": true } },
 *     "hook": { "consent": "accepted" | "declined", ... },
 *     "updateCheck": bool
 *   }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { escapeRegExp } from './regex.mjs';


/**
 * A colour parsed out of an ignore entry, in 8-bit sRGB with straight alpha.
 * @typedef {{ r: number, g: number, b: number, a: number }} IgnoreColor
 */

/**
 * One value-scoped ignore: the rule it waives, the value it matches, and the
 * optional evidence a reader needs to judge it.
 * @typedef {{ rule: string, value: string, files?: string[], reason?: string, createdAt?: string }} IgnoreValueEntry
 */

/**
 * The detector settings a project declares, after the config files are merged.
 * @typedef {{ ignoreRules: string[], ignoreFiles: string[], ignoreValues: IgnoreValueEntry[], designSystem?: { enabled: boolean } }} DetectionConfig
 */

/**
 * A config file as it is read off disk: the sections this module owns, beside
 * whatever else the file carries, which is written back untouched.
 * @typedef {{ hook?: Record<string, unknown>, detector?: Record<string, unknown> } & Record<string, unknown>} RawConfigFile
 */

/**
 * A detector section before validation — every member is whatever JSON held.
 * @typedef {{ designSystem?: { enabled?: unknown }, ignoreRules?: unknown, ignoreFiles?: unknown, ignoreValues?: unknown }} RawDetectorSection
 */

/** @param {string} root */
export function getConfigPath(root) {
  return join(root, '.impeccable', 'config.json');
}

/** @param {string} root */
export function getLocalConfigPath(root) {
  return join(root, '.impeccable', 'config.local.json');
}

/**
 * @param {string} filePath
 * @returns {RawConfigFile | null}
 */
function safeReadJson(filePath) {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * @param {RawConfigFile | null} raw
 * @returns {Record<string, unknown> | null}
 */
function hookSection(raw) {
  return raw && raw.hook && typeof raw.hook === 'object' && !Array.isArray(raw.hook) ? raw.hook : null;
}

/**
 * @param {RawConfigFile | null} raw
 * @returns {RawDetectorSection | null}
 */
function detectorSection(raw) {
  return raw && raw.detector && typeof raw.detector === 'object' && !Array.isArray(raw.detector) ? raw.detector : null;
}

const DETECTOR_CONFIG_KEYS = new Set(['ignoreRules', 'ignoreFiles', 'ignoreValues', 'designSystem']);

const DEFAULT_DETECTION_CONFIG = Object.freeze({
  ignoreRules: [],
  ignoreFiles: [],
  ignoreValues: [],
  designSystem: { enabled: true },
});

/** @returns {DetectionConfig} */
function cloneDetectionConfig() {
  return {
    ignoreRules: [],
    ignoreFiles: [],
    ignoreValues: [],
    designSystem: { ...DEFAULT_DETECTION_CONFIG.designSystem },
  };
}

/** @returns {DetectionConfig} */
function cloneRawDetectionConfig() {
  return {
    ignoreRules: [],
    ignoreFiles: [],
    ignoreValues: [],
  };
}

/**
 * @param {DetectionConfig} config
 * @param {RawDetectorSection | null} raw
 * @returns {DetectionConfig}
 */
function applyDetectionConfigSource(config, raw) {
  if (!raw || typeof raw !== 'object') return config;
  if (raw.designSystem && typeof raw.designSystem === 'object' && !Array.isArray(raw.designSystem)) {
    config.designSystem = {
      ...config.designSystem,
      enabled: raw.designSystem.enabled === false ? false : true,
    };
  }
  if (Array.isArray(raw.ignoreRules)) {
    config.ignoreRules = uniqueStrings([...config.ignoreRules, ...raw.ignoreRules]);
  }
  if (Array.isArray(raw.ignoreFiles)) {
    config.ignoreFiles = uniqueStrings([...config.ignoreFiles, ...raw.ignoreFiles]);
  }
  if (Array.isArray(raw.ignoreValues)) {
    config.ignoreValues = mergeIgnoreValues(config.ignoreValues, raw.ignoreValues);
  }
  return config;
}

/** @param {readonly unknown[]} values */
function uniqueStrings(values) {
  return Array.from(new Set(values.map(String)));
}

/**
 * Detector filters shared by `npx impeccable detect` and the design hook.
 * `hook.enabled` remains hook lifecycle state; manual CLI scans still run when
 * the hook is disabled, but they honor the same ignore rules and design-system
 * toggle.
 */
/** @param {string} root */
export function readDetectionConfig(root) {
  const config = cloneDetectionConfig();
  for (const filePath of [getConfigPath(root), getLocalConfigPath(root)]) {
    const raw = safeReadJson(filePath);
    // Back-compat: old builds stored detector filters under hook.*.
    applyDetectionConfigSource(config, hookSection(raw));
    applyDetectionConfigSource(config, detectorSection(raw));
  }
  return config;
}

/**
 * @param {string} root
 * @param {{ local?: boolean }} [opts]
 */
export function readRawDetectionConfig(root, opts = {}) {
  const raw = safeReadJson(opts.local ? getLocalConfigPath(root) : getConfigPath(root));
  const config = cloneRawDetectionConfig();
  applyDetectionConfigSource(config, hookSection(raw));
  applyDetectionConfigSource(config, detectorSection(raw));
  return config;
}

/**
 * @param {string} root
 * @param {Partial<DetectionConfig> | null | undefined} detectorConfig
 * @param {{ local?: boolean }} [opts]
 */
export function writeDetectionConfig(root, detectorConfig, opts = {}) {
  const filePath = opts.local ? getLocalConfigPath(root) : getConfigPath(root);
  if (opts.local) ensureConfigGitExclude(root);
  /** @type {RawConfigFile} */
  const existing = safeReadJson(filePath) || {};
  const existingHook = hookSection(existing);
  const nextHook = stripDetectorKeys(existingHook);
  const nextDetector = {
    ...(detectorSection(existing) || {}),
    ...normalizeDetectionConfigForWrite(detectorConfig),
  };
  /** @type {RawConfigFile} */
  const next = {
    ...existing,
    detector: nextDetector,
  };
  if (nextHook && Object.keys(nextHook).length > 0) {
    next.hook = nextHook;
  } else {
    delete next.hook;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return filePath;
}

/**
 * @param {Partial<DetectionConfig> | null | undefined} config
 * @returns {Record<string, unknown>}
 */
function normalizeDetectionConfigForWrite(config) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (Array.isArray(config?.ignoreRules)) {
    out['ignoreRules'] = uniqueStrings(
      config.ignoreRules.map((rule) => normalizeIgnoreRule(rule)).filter(Boolean)
    );
  }
  if (Array.isArray(config?.ignoreFiles)) {
    out['ignoreFiles'] = uniqueStrings(
      config.ignoreFiles.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
    );
  }
  out['ignoreValues'] = normalizeIgnoreValueEntries(config?.ignoreValues || []);
  if (config?.designSystem && typeof config.designSystem === 'object' && !Array.isArray(config.designSystem)) {
    out['designSystem'] = {
      enabled: config.designSystem.enabled === false ? false : true,
    };
  }
  return out;
}

/**
 * @param {Record<string, unknown> | null} raw
 * @returns {Record<string, unknown> | null}
 */
function stripDetectorKeys(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!DETECTOR_CONFIG_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** @param {unknown} value */
export function normalizeIgnoreValue(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** @param {unknown} rule */
function normalizeIgnoreRule(rule) {
  return String(rule || '').trim().toLowerCase();
}

/** @param {unknown} value */
function colorIgnoreKey(value) {
  const color = parseIgnoreColor(value);
  if (!color) return '';
  return `${color.r},${color.g},${color.b},${Math.round(color.a * 255)}`;
}

/**
 * @param {unknown} value
 * @returns {IgnoreColor | null}
 */
function parseIgnoreColor(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;

  const hex = /** @type {readonly [string, string] | null} */ (
    text.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  );
  if (hex) return parseHexIgnoreColor(hex[1]);

  const rgb = /** @type {readonly [string, string] | null} */ (text.match(/^rgba?\((.*)\)$/i));
  if (rgb) {
    const parts = splitColorArgs(rgb[1]);
    if (parts.length < 3 || parts.length > 4) return null;
    const r = parseRgbChannel(parts[0]);
    const g = parseRgbChannel(parts[1]);
    const b = parseRgbChannel(parts[2]);
    const a = parts[3] === undefined ? 1 : parseAlphaChannel(parts[3]);
    if (r === null || g === null || b === null || a === null) return null;
    return { r, g, b, a };
  }

  const hsl = /** @type {readonly [string, string] | null} */ (text.match(/^hsla?\((.*)\)$/i));
  if (hsl) {
    const parts = splitColorArgs(hsl[1]);
    if (parts.length < 3 || parts.length > 4) return null;
    const h = parseHueChannel(parts[0]);
    const s = parsePercentChannel(parts[1]);
    const l = parsePercentChannel(parts[2]);
    const a = parts[3] === undefined ? 1 : parseAlphaChannel(parts[3]);
    if (h === null || s === null || l === null || a === null) return null;
    return hslToRgb(h, s, l, a);
  }

  return null;
}

/**
 * @param {string} hex
 * @returns {IgnoreColor}
 */
function parseHexIgnoreColor(hex) {
  if (hex.length === 3 || hex.length === 4) {
    const digits = hex.split('');
    /** @param {number} index */
    const doubled = (index) => {
      const digit = /** @type {string} */ (digits[index]);
      return parseInt(digit + digit, 16);
    };
    const r = doubled(0);
    const g = doubled(1);
    const b = doubled(2);
    const a = hex.length === 4 ? doubled(3) / 255 : 1;
    return { r, g, b, a };
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

/**
 * @param {unknown} body
 * @returns {string[]}
 */
function splitColorArgs(body) {
  const text = String(body || '').trim();
  if (!text) return [];
  if (text.includes(',')) {
    const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && last.includes('/')) {
      const split = last.split('/').map((part) => part.trim()).filter(Boolean);
      return [...parts.slice(0, -1), ...split];
    }
    return parts;
  }
  return text.replace(/\s*\/\s*/g, ' / ').split(/\s+/).filter((part) => part && part !== '/');
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function parseRgbChannel(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^(-?\d*\.?\d+)(%)?$/);
  if (!match) return null;
  const value = Number.parseFloat(/** @type {string} */ (match[1]));
  if (!Number.isFinite(value)) return null;
  const scaled = match[2] ? value * 2.55 : value;
  if (scaled < 0 || scaled > 255) return null;
  return Math.round(scaled);
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function parseAlphaChannel(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^(-?\d*\.?\d+)(%)?$/);
  if (!match) return null;
  const value = Number.parseFloat(/** @type {string} */ (match[1]));
  if (!Number.isFinite(value)) return null;
  const alpha = match[2] ? value / 100 : value;
  return alpha >= 0 && alpha <= 1 ? alpha : null;
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function parseHueChannel(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^(-?\d*\.?\d+)(deg|rad|turn|grad)?$/);
  if (!match) return null;
  const value = Number.parseFloat(/** @type {string} */ (match[1]));
  if (!Number.isFinite(value)) return null;
  const unit = match[2] || 'deg';
  if (unit === 'turn') return value * 360;
  if (unit === 'rad') return value * (180 / Math.PI);
  if (unit === 'grad') return value * 0.9;
  return value;
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function parsePercentChannel(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^(-?\d*\.?\d+)%$/);
  if (!match) return null;
  const value = Number.parseFloat(/** @type {string} */ (match[1]));
  if (!Number.isFinite(value)) return null;
  return value >= 0 && value <= 100 ? value / 100 : null;
}

/**
 * @param {number} hue
 * @param {number} saturation
 * @param {number} lightness
 * @param {number} alpha
 * @returns {IgnoreColor}
 */
function hslToRgb(hue, saturation, lightness, alpha) {
  const h = (((hue % 360) + 360) % 360) / 360;
  if (saturation === 0) {
    const gray = clampByte(Math.round(lightness * 255));
    return { r: gray, g: gray, b: gray, a: alpha };
  }
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  /** @param {number} t */
  const toRgb = (t) => {
    let channel = t;
    if (channel < 0) channel += 1;
    if (channel > 1) channel -= 1;
    if (channel < 1 / 6) return p + (q - p) * 6 * channel;
    if (channel < 1 / 2) return q;
    if (channel < 2 / 3) return p + (q - p) * (2 / 3 - channel) * 6;
    return p;
  };
  return {
    r: clampByte(Math.round(toRgb(h + 1 / 3) * 255)),
    g: clampByte(Math.round(toRgb(h) * 255)),
    b: clampByte(Math.round(toRgb(h - 1 / 3) * 255)),
    a: alpha,
  };
}

/** @param {number} value */
function clampByte(value) {
  return Math.min(255, Math.max(0, value));
}

/**
 * @param {string} rule
 * @param {string} entryValue
 * @param {string} findingValue
 */
function ignoreValueMatches(rule, entryValue, findingValue) {
  if (entryValue === findingValue) return true;
  if (rule !== 'design-system-color') return false;
  const entryColor = colorIgnoreKey(entryValue);
  return Boolean(entryColor && entryColor === colorIgnoreKey(findingValue));
}

/**
 * @param {unknown} entries
 * @returns {IgnoreValueEntry[]}
 */
export function normalizeIgnoreValueEntries(entries) {
  if (!Array.isArray(entries)) return [];
  /** @type {IgnoreValueEntry[]} */
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const rule = normalizeIgnoreRule(entry.rule);
    const value = normalizeIgnoreValue(entry.value);
    if (!rule || !value) continue;
    /** @type {IgnoreValueEntry} */
    const normalized = { rule, value };
    const files = uniqueStrings([
      ...(typeof entry.file === 'string' && entry.file.trim() ? [entry.file.trim()] : []),
      ...(Array.isArray(entry.files)
        ? entry.files
            .filter((/** @type {unknown} */ v) => typeof v === 'string' && v.trim())
            .map((/** @type {string} */ v) => v.trim())
        : []),
    ]);
    if (files.length > 0) normalized.files = files;
    if (typeof entry.reason === 'string' && entry.reason.trim()) {
      normalized.reason = entry.reason.trim();
    }
    if (typeof entry.createdAt === 'string' && entry.createdAt.trim()) {
      normalized.createdAt = entry.createdAt.trim();
    }
    out.push(normalized);
  }
  return out;
}

/**
 * @param {unknown} existing
 * @param {unknown} incoming
 * @returns {IgnoreValueEntry[]}
 */
function mergeIgnoreValues(existing, incoming) {
  /** @type {Map<string, IgnoreValueEntry>} */
  const map = new Map();
  for (const entry of normalizeIgnoreValueEntries(existing)) {
    map.set(`${entry.rule}\0${entry.value}\0${ignoreValueFilesKey(entry.files)}`, entry);
  }
  for (const entry of normalizeIgnoreValueEntries(incoming)) {
    map.set(`${entry.rule}\0${entry.value}\0${ignoreValueFilesKey(entry.files)}`, entry);
  }
  return Array.from(map.values());
}

/** @param {readonly string[] | undefined} files */
function ignoreValueFilesKey(files) {
  return Array.isArray(files) && files.length > 0 ? files.join('\x1f') : '';
}

// Glob -> RegExp. Supports `**`, `*`, `?`, and `{a,b}` alternation.
/** @param {string} glob */
function globToRegex(glob) {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = /** @type {string} */ (glob[i]);
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (glob[i] === '/') i += 1;
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { re += '\\{'; i += 1; continue; }
      const parts = glob.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&'));
      re += `(?:${parts.join('|')})`;
      i = end + 1;
    } else if (/[.+^$()|[\]\\]/.test(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += '$';
  return new RegExp(re);
}

/**
 * @param {unknown} filePath
 * @param {unknown} globs
 */
export function matchesAnyGlob(filePath, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return false;
  const normalized = String(filePath || '').split(sep).join('/');
  for (const glob of globs) {
    try {
      const re = globToRegex(String(glob));
      if (re.test(normalized)) return true;
      const base = normalized.split('/').pop();
      if (base !== undefined && re.test(base)) return true;
    } catch {
      /* malformed glob, skip */
    }
  }
  return false;
}

/**
 * @param {unknown} filePath
 * @param {string} root
 * @param {Partial<DetectionConfig> | null | undefined} config
 */
export function shouldIgnoreDetectionFile(filePath, root, config) {
  const globs = config?.ignoreFiles || [];
  if (!Array.isArray(globs) || globs.length === 0) return false;
  const raw = String(filePath || '').trim();
  if (!raw) return false;
  if (matchesAnyGlob(raw, globs)) return true;

  try {
    const abs = isAbsolute(raw) ? raw : resolve(root, raw);
    if (matchesAnyGlob(abs, globs)) return true;
    const rel = relative(root, abs);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      return matchesAnyGlob(rel, globs);
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * @param {unknown} findings
 * @param {Partial<DetectionConfig> | null | undefined} config
 * @returns {import('../detector/findings.mjs').Finding[]}
 */
export function filterDetectionFindings(findings, config) {
  if (!Array.isArray(findings) || findings.length === 0) return [];
  const ignoreRules = new Set((config?.ignoreRules || []).map((rule) => normalizeIgnoreRule(rule)));
  const ignoreValues = normalizeIgnoreValueEntries(config?.ignoreValues || []);
  return findings.filter((finding) => {
    if (!finding || typeof finding !== 'object') return false;
    if (ignoreRules.has(normalizeIgnoreRule(finding.antipattern))) return false;
    if (isIgnoredFindingValue(finding, ignoreValues)) return false;
    return true;
  });
}

/**
 * @param {Record<string, unknown> & { antipattern?: unknown, file?: unknown, detail?: unknown, snippet?: unknown, ignoreValue?: unknown, value?: unknown }} finding
 * @param {readonly IgnoreValueEntry[]} ignoreValues
 */
function isIgnoredFindingValue(finding, ignoreValues) {
  if (!Array.isArray(ignoreValues) || ignoreValues.length === 0) return false;
  const rule = normalizeIgnoreRule(finding.antipattern);
  const value = extractFindingIgnoreValue(finding);
  if (!rule || !value) return false;
  return ignoreValues.some((entry) => {
    const wildcardValue = entry.value === '*';
    if (entry.rule !== rule || (!wildcardValue && !ignoreValueMatches(rule, entry.value, value))) return false;
    if (!Array.isArray(entry.files) || entry.files.length === 0) return !wildcardValue;
    return findingMatchesScopedIgnoreFile(finding, entry.files);
  });
}

/**
 * @param {(Record<string, unknown> & { antipattern?: unknown, file?: unknown, detail?: unknown, snippet?: unknown, ignoreValue?: unknown, value?: unknown }) | null | undefined} finding
 * @param {readonly string[]} globs
 */
function findingMatchesScopedIgnoreFile(finding, globs) {
  const filePath = String(finding?.file || '').trim();
  if (!filePath) return false;
  if (matchesAnyGlob(filePath, globs)) return true;

  const normalized = filePath.split(sep).join('/');
  const parts = normalized.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.slice(i).join('/');
    if (matchesAnyGlob(suffix, globs)) return true;
  }
  return false;
}

/** @param {(Record<string, unknown> & { antipattern?: unknown, file?: unknown, detail?: unknown, snippet?: unknown, ignoreValue?: unknown, value?: unknown }) | null | undefined} finding */
export function extractFindingIgnoreValue(finding) {
  if (!finding || typeof finding !== 'object') return '';
  const rule = normalizeIgnoreRule(finding.antipattern);
  const directValueRules = new Set([
    'overused-font',
    'bounce-easing',
    'design-system-font',
    'design-system-color',
    'design-system-radius',
  ]);
  if (!directValueRules.has(rule)) return '';
  return normalizeIgnoreValue(extractFindingIgnoreValueRaw(finding, rule));
}

/**
 * @param {Record<string, unknown> & { antipattern?: unknown, file?: unknown, detail?: unknown, snippet?: unknown, ignoreValue?: unknown, value?: unknown }} finding
 * @param {string} [rule]
 */
function extractFindingIgnoreValueRaw(finding, rule = normalizeIgnoreRule(finding?.antipattern)) {
  const direct = cleanIgnoreValueDisplay(finding.ignoreValue || finding.value || '');
  if (direct) return direct;

  const candidates = /** @type {string[]} */ (
    [finding.detail, finding.snippet].filter((v) => typeof v === 'string' && v)
  );
  for (const text of candidates) {
    if (rule === 'bounce-easing') {
      const motion = extractMotionIgnoreValue(text);
      if (motion) return motion;
      continue;
    }

    const primary = text.match(/Primary font:\s*([^()\n;]+)/i);
    if (primary) return cleanIgnoreValueDisplay(primary[1]);

    const family = text.match(/font-family\s*:\s*["']?([^'",;\n]+)/i);
    if (family) return cleanIgnoreValueDisplay(family[1]);

    const google = text.match(/[?&]family=([^&:;\n]+)/i);
    if (google) {
      try {
        return cleanIgnoreValueDisplay(decodeURIComponent(/** @type {string} */ (google[1])));
      } catch {
        return cleanIgnoreValueDisplay(google[1]);
      }
    }
  }

  return '';
}

/** @param {string} text */
function extractMotionIgnoreValue(text) {
  const tailwind = text.match(/\banimate-bounce\b/i);
  if (tailwind) return cleanIgnoreValueDisplay(tailwind[0]);

  const bezier = text.match(/cubic-bezier\([^)]+\)/i);
  if (bezier) return cleanIgnoreValueDisplay(bezier[0]);

  const animation = text.match(/animation(?:-name)?\s*:\s*([^;\n]+)/i);
  if (animation) {
    const token = /** @type {string} */ (animation[1])
      .split(/[,\s]+/)
      .find((part) => /bounce|elastic|wobble|jiggle|spring/i.test(part));
    if (token) return cleanIgnoreValueDisplay(token);
  }

  return '';
}

/** @param {unknown} value */
function cleanIgnoreValueDisplay(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\+/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * The recorded design-hook decision: 'accepted' | 'declined' | undefined.
 * config.local.json (per-developer) overrides config.json.
 */
/**
 * @param {string} root
 * @returns {string | undefined}
 */
export function getHookConsent(root) {
  /** @type {string | undefined} */
  let consent;
  for (const filePath of [getConfigPath(root), getLocalConfigPath(root)]) {
    const hook = hookSection(safeReadJson(filePath));
    const hookConsent = hook?.['consent'];
    if (hookConsent === 'accepted' || hookConsent === 'declined') consent = hookConsent;
  }
  return consent;
}

/**
 * Persist the per-developer decision to config.local.json, preserving any
 * sibling keys, and ensure the file is gitignored.
 */
/**
 * @param {string} root
 * @param {string} value
 */
export function setHookConsent(root, value) {
  const filePath = getLocalConfigPath(root);
  /** @type {RawConfigFile} */
  const existing = safeReadJson(filePath) || {};
  const hook = hookSection(existing) || {};
  const next = { ...existing, hook: { ...hook, consent: value } };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
  ensureConfigGitExclude(root);
  return filePath;
}

const EXCLUDE_OPEN = '# impeccable-config-ignore-start';
const EXCLUDE_CLOSE = '# impeccable-config-ignore-end';
const EXCLUDE_PATTERNS = ['.impeccable/config.local.json'];

/**
 * Add config.local.json to `.git/info/exclude` so a developer's decision is
 * never committed. Idempotent via marker comments. Best-effort; returns false
 * when there is no resolvable git dir.
 */
/** @param {string} root */
export function ensureConfigGitExclude(root) {
  try {
    const gitDir = resolveGitDir(root);
    if (!gitDir) return false;
    const target = join(gitDir, 'info', 'exclude');
    const existing = existsSync(target) ? readFileSync(target, 'utf-8') : '';
    const block = [EXCLUDE_OPEN, ...EXCLUDE_PATTERNS, EXCLUDE_CLOSE].join('\n');
    const markerRe = new RegExp(`${escapeRegExp(EXCLUDE_OPEN)}[\\s\\S]*?${escapeRegExp(EXCLUDE_CLOSE)}`);
    /** @type {string} */
    let updated;
    if (markerRe.test(existing)) {
      updated = existing.replace(markerRe, block);
    } else {
      const prefix = existing.length === 0 ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
      updated = `${prefix}${block}\n`;
    }
    if (updated !== existing) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, updated);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} root
 * @returns {string | null}
 */
function resolveGitDir(root) {
  const dotGit = join(root, '.git');
  if (!existsSync(dotGit)) return null;
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    // A `.git` file (worktree/submodule) points elsewhere: "gitdir: <path>".
    const match = readFileSync(dotGit, 'utf-8').match(/gitdir:\s*(.+)/);
    if (match) {
      const resolved = /** @type {string} */ (match[1]).trim();
      return isAbsolute(resolved) ? resolved : join(root, resolved);
    }
  } catch {
    /* fall through */
  }
  return null;
}
