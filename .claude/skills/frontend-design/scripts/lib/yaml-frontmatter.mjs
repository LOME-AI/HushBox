// The one reader for the Stitch YAML frontmatter block. Both the DESIGN.md
// prose parser (`design-parser.mjs`) and the detector's design-system loader
// (`detector/design-system.mjs`) read the *same* frontmatter out of the *same*
// file, so the dialect they accept has to be one implementation: if the two
// drifted, the detector would resolve a token to a different value than the
// parser produced from the same source and report a violation against a colour
// the parser never emitted.

// Minimal YAML reader for the Stitch frontmatter subset: scalar maps with
// one level of nested objects (typography roles, components). Indent-based,
// 2-space convention. No arrays, no anchors, no multi-line scalars — Stitch's
// schema doesn't need them and accepting them would require a real YAML
// dependency we don't want to vendor.
/**
 * @param {string} yaml
 * @returns {Record<string, unknown>}
 */
function parseYamlSubset(yaml) {
  const lines = yaml.split(/\r?\n/);
  /** @type {Record<string, unknown>} */
  const root = {};
  /** @type {{ indent: number, obj: Record<string, unknown> }[]} */
  const stack = [{ indent: -1, obj: root }];

  for (const raw of lines) {
    // Skip blanks and line-only comments. Don't strip inline comments:
    // unquoted hex values start with `#` and can't be safely distinguished
    // from a comment after whitespace.
    if (!raw.trim() || /^\s*#/.test(raw)) continue;

    // The pattern matches the empty string at worst, so a match always exists.
    const indent = /** @type {RegExpMatchArray} */ (raw.match(/^\s*/))[0].length;
    const content = raw.slice(indent);

    const colonIdx = findTopLevelColon(content);
    if (colonIdx === -1) continue;

    while (stack.length > 1 && /** @type {{ indent: number }} */ (stack[stack.length - 1]).indent >= indent) {
      stack.pop();
    }

    const key = unquoteYamlKey(content.slice(0, colonIdx).trim());
    const rest = stripInlineYamlComment(content.slice(colonIdx + 1).trim());
    // The stack is seeded with the root and never emptied below it.
    const parent = /** @type {{ obj: Record<string, unknown> }} */ (stack[stack.length - 1]).obj;

    if (rest === '') {
      /** @type {Record<string, unknown>} */
      const obj = {};
      parent[key] = obj;
      stack.push({ indent, obj });
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return root;
}

/** @param {string} s */
function findTopLevelColon(s) {
  /** @type {string | null} */
  let inQuote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote && s[i - 1] !== '\\') inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ':') {
      return i;
    }
  }
  return -1;
}

// Exported because the detector's design-system loader unquotes the same keys
// off the JSON sidecar, which never passes through this reader. A second rule
// for the same spelling would let a token name resolve differently depending on
// which file declared it.
/** @param {string} key */
export function unquoteYamlKey(key) {
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    return key.slice(1, -1);
  }
  return key;
}

/** @param {string} s */
function stripInlineYamlComment(s) {
  /** @type {string | null} */
  let inQuote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote && s[i - 1] !== '\\') inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === '#' && i > 0 && /\s/.test(/** @type {string} */ (s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

/**
 * @param {string} raw
 * @returns {string | number | boolean | null}
 */
function parseScalar(raw) {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

// Returns both halves so a caller that only wants the tokens and a caller that
// also renders the prose share one answer about where the block ends.
// `frontmatter` is null when there is no well-formed block; `body` is then the
// whole document.
/**
 * @param {string} md
 * @returns {{ frontmatter: Record<string, unknown> | null, body: string }}
 */
export function parseFrontmatter(md) {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { frontmatter: null, body: md };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/** @type {string} */ (lines[i]).trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: null, body: md };

  const yaml = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  try {
    return { frontmatter: parseYamlSubset(yaml), body };
  } catch {
    return { frontmatter: null, body: md };
  }
}
