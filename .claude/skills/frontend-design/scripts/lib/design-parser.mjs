// Parse a DESIGN.md (Stitch-spec format) into a structured JSON model that
// the live-mode design-system panel can render. Deterministic, dependency-free.
//
// Two-layer: YAML frontmatter (machine-readable tokens) + markdown body
// (prose with six canonical H2 sections). When frontmatter is present, it's
// exposed on `model.frontmatter` alongside the prose-scraped sections;
// consumers can prefer frontmatter values and fall back to prose.

import { escapeRegExp } from './regex.mjs';
import { parseFrontmatter } from './yaml-frontmatter.mjs';


/**
 * One `##` section of a design document, with its body kept as raw lines so
 * every extractor reads the same text.
 * @typedef {{ name: string, subtitle: string | null, lines: string[] }} Section
 */

/** One `###` block inside a section; the first has no name.
 * @typedef {{ name: string | null, lines: string[] }} Subsection
 */

/** A named rule a document states in prose.
 * @typedef {{ name: string, body: string }} NamedRule
 */

/** One colour the document declares.
 * @typedef {{ name: string | null, value: string, valueRange: string[] | null, format: string, description: string | null }} DesignColor
 */

/** One elevation entry the document declares.
 * @typedef {{ name: string | null, value: string, purpose: string | null }} DesignShadow
 */

const CANONICAL_SECTIONS = [
  'Overview',
  'Colors',
  'Typography',
  'Elevation',
  'Components',
  "Do's and Don'ts",
];

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const OKLCH_RE = /oklch\([^)]+\)/gi;

// ---------- Section splitting ----------

/**
 * @param {string} md
 * @returns {{ title: string | null, sections: Record<string, Section> }}
 */
function splitSections(md) {
  const lines = md.split(/\r?\n/);
  /** @type {string | null} */
  let title = null;
  /** @type {Record<string, Section>} */
  const sections = {};
  /** @type {Section | null} */
  let current = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!title && line.startsWith('# ') && !line.startsWith('## ')) {
      title = line.replace(/^#\s+/, '').trim();
      continue;
    }

    const h2 = line.match(/^##\s+(?:\d+\.\s*)?([^:\n]+?)(?::\s*(.+))?$/);
    if (h2) {
      const rawName = normalizeApostrophes(/** @type {string} */ (h2[1]).trim());
      const subtitle = h2[2] ? h2[2].trim() : null;
      const canonical = matchCanonicalSection(rawName);
      if (canonical) {
        current = { name: canonical, subtitle, lines: [] };
        sections[canonical] = current;
        continue;
      }
      // non-canonical H2 — ignore but stop feeding into current
      current = null;
      continue;
    }

    if (current) current.lines.push(raw);
  }

  return { title, sections };
}

/** @param {string} s */
function normalizeApostrophes(s) {
  return s.replace(/[\u2018\u2019]/g, "'");
}

/**
 * @param {string} name
 * @returns {string | null}
 */
function matchCanonicalSection(name) {
  const normalized = normalizeApostrophes(name).toLowerCase();
  // Exact match first
  for (const c of CANONICAL_SECTIONS) {
    if (normalizeApostrophes(c).toLowerCase() === normalized) return c;
  }
  // Keyword-contained match: "Overview & Creative North Star" -> "Overview",
  // "Elevation & Depth" -> "Elevation", etc.
  for (const c of CANONICAL_SECTIONS) {
    const key = normalizeApostrophes(c).toLowerCase();
    const pattern = new RegExp(`\\b${escapeRegExp(key)}\\b`);
    if (pattern.test(normalized)) return c;
  }
  return null;
}

// ---------- Subsection splitting (inside a canonical section) ----------

/**
 * @param {readonly string[]} lines
 * @returns {Subsection[]}
 */
function splitSubsections(lines) {
  /** @type {Subsection[]} */
  const subs = [];
  /** @type {Subsection} */
  let current = { name: null, lines: [] };
  subs.push(current);

  for (const raw of lines) {
    const h3 = raw.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      current = { name: /** @type {string} */ (h3[1]).trim(), lines: [] };
      subs.push(current);
      continue;
    }
    current.lines.push(raw);
  }

  return subs;
}

// ---------- Generic helpers ----------

/**
 * @param {readonly string[]} lines
 * @returns {string[]}
 */
function collectParagraphs(lines) {
  /** @type {string[]} */
  const paragraphs = [];
  /** @type {string[]} */
  let buf = [];
  const flush = () => {
    if (buf.length) {
      paragraphs.push(buf.join(' ').trim());
      buf = [];
    }
  };
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '') { flush(); continue; }
    // Horizontal rules (---, ***) and headings/bullets end a paragraph.
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); continue; }
    if (raw.startsWith('#') || raw.match(/^[-*]\s/)) { flush(); continue; }
    buf.push(trimmed);
  }
  flush();
  return paragraphs.filter(Boolean);
}

/**
 * @param {readonly string[]} lines
 * @returns {string[]}
 */
function collectBullets(lines) {
  /** @type {string[]} */
  const bullets = [];
  /** @type {string | null} */
  let current = null;
  for (const raw of lines) {
    const m = raw.match(/^\s*[-*]\s+(.+)$/);
    if (m) {
      if (current) bullets.push(current);
      current = /** @type {string} */ (m[1]);
      continue;
    }
    // continuation of a bullet (indented line)
    if (current && raw.match(/^\s{2,}\S/)) {
      current += ' ' + raw.trim();
      continue;
    }
    // blank line ends a bullet
    if (raw.trim() === '' && current) {
      bullets.push(current);
      current = null;
    }
  }
  if (current) bullets.push(current);
  return bullets;
}

/** @param {string} s */
function stripBold(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '$1');
}

/**
 * @param {readonly string[]} lines
 * @returns {NamedRule[]}
 */
function extractNamedRules(lines) {
  /** @type {NamedRule[]} */
  const rules = [];
  /** @type {Set<string>} */
  const seen = new Set();

  // Style A (Impeccable): "**The X Rule.** body body body" — can span lines.
  const joined = lines.join('\n');
  const inlineStart = /\*\*(The [^*]+?Rule)\.\*\*/g;
  /** @type {{ name: string, start: number, end: number }[]} */
  const inlineMatches = [];
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = inlineStart.exec(joined)) !== null) {
    inlineMatches.push({
      name: /** @type {string} */ (m[1]),
      start: m.index,
      end: inlineStart.lastIndex,
    });
  }
  for (let i = 0; i < inlineMatches.length; i++) {
    const mm = /** @type {{ name: string, start: number, end: number }} */ (inlineMatches[i]);
    const bodyEnd =
      i + 1 < inlineMatches.length
        ? /** @type {{ start: number }} */ (inlineMatches[i + 1]).start
        : joined.length;
    const body = joined
      .slice(mm.end, bodyEnd)
      .replace(/\n##[^\n]*$/s, '')
      .replace(/\n###[^\n]*$/s, '')
      .trim();
    const name = stripBold(mm.name).trim();
    seen.add(name.toLowerCase());
    rules.push({ name, body: stripBold(body) });
  }

  // Style B (Stitch): `### The "X" Rule` or `### The X Fallback`, body is the
  // bullets/paragraphs until the next heading. Accept Rule / Fallback / Principle.
  for (let i = 0; i < lines.length; i++) {
    const h3 = /** @type {string} */ (lines[i]).match(/^###\s+(.+?)\s*$/);
    if (!h3) continue;
    const headerName = stripBold(/** @type {string} */ (h3[1])).replace(/["“”]/g, '').trim();
    if (!/^The\b.*\b(Rule|Fallback|Principle)\b/i.test(headerName)) continue;
    if (seen.has(headerName.toLowerCase())) continue;

    /** @type {string[]} */
    const bodyLines = [];
    for (let j = i + 1; j < lines.length; j++) {
      const bodyLine = /** @type {string} */ (lines[j]);
      if (/^##\s|^###\s/.test(bodyLine)) break;
      bodyLines.push(bodyLine);
    }
    const body = stripBold(bodyLines.join('\n').replace(/\n+/g, ' ')).trim();
    if (body) {
      seen.add(headerName.toLowerCase());
      rules.push({ name: headerName, body });
    }
  }

  // Style C (Stitch bullet form): "*   **The Layering Principle:** body"
  // Colon/period lives inside the bold, so match "**...**" then inspect.
  for (const b of collectBullets(lines)) {
    const mm = b.match(/^\*\*([^*]+?)\*\*\s*(.+)$/);
    if (!mm) continue;
    const nameRaw = /** @type {string} */ (mm[1]).replace(/[.:]\s*$/, '').replace(/["“”]/g, '').trim();
    if (!/^The\b.+\b(Rule|Fallback|Principle)$/i.test(nameRaw)) continue;
    if (seen.has(nameRaw.toLowerCase())) continue;
    seen.add(nameRaw.toLowerCase());
    rules.push({ name: nameRaw, body: stripBold(/** @type {string} */ (mm[2])).trim() });
  }

  return rules;
}

// ---------- Per-section extractors ----------

/** @param {Section | undefined} section */
function extractOverview(section) {
  if (!section) return null;
  const text = section.lines.join('\n');
  const northStar = text.match(/\*\*Creative North Star:\s*"([^"]+)"\*\*/);
  /** @type {string[]} */
  const keyChars = [];
  const keyCharMatch = text.match(/\*\*Key Characteristics:\*\*\s*\n([\s\S]+?)(?:\n##|\n###|$)/);
  if (keyCharMatch) {
    for (const line of /** @type {string} */ (keyCharMatch[1]).split('\n')) {
      const m = line.match(/^\s*[-*]\s+(.+)$/);
      if (m) keyChars.push(stripBold(/** @type {string} */ (m[1]).trim()));
    }
  }

  // Philosophy paragraphs: everything that isn't a rule header or key-char block
  const paragraphs = collectParagraphs(section.lines).filter(
    (p) =>
      !p.startsWith('**Creative North Star') &&
      !p.startsWith('**Key Characteristics')
  );

  return {
    subtitle: section.subtitle,
    creativeNorthStar: northStar ? northStar[1] : null,
    philosophy: paragraphs,
    keyCharacteristics: keyChars,
  };
}

/** @param {Section | undefined} section */
function extractColors(section) {
  if (!section) return null;
  const subs = splitSubsections(section.lines);

  const description = collectParagraphs(/** @type {Subsection} */ (subs[0]).lines).join(' ');
  /** @type {{ role: string, colors: DesignColor[] }[]} */
  const groups = [];
  const ROLE_KEYWORDS = /^(primary|secondary|tertiary|neutral|accent)\b/i;

  for (const sub of subs.slice(1)) {
    if (!sub.name || /Named Rules?/i.test(sub.name) || /^The\s/i.test(sub.name)) continue;

    const bullets = collectBullets(sub.lines);
    const parsed = /** @type {DesignColor[]} */ (
      bullets.map((b) => parseColorBullet(b)).filter(Boolean)
    );
    if (parsed.length === 0) continue;

    // If every bullet starts with a role keyword (Primary/Secondary/...), promote
    // each bullet to its own group. Otherwise keep the subsection as the group.
    const allRoleBullets =
      parsed.length > 0 && parsed.every((p) => p.name && ROLE_KEYWORDS.test(p.name));

    if (allRoleBullets) {
      for (const p of parsed) {
        groups.push({ role: /** @type {string} */ (p.name), colors: [p] });
      }
    } else {
      groups.push({ role: /** @type {string} */ (sub.name), colors: parsed });
    }
  }

  // If the Colors section has no subsections at all (unlikely), fall back to
  // scanning the whole section as a flat bullet list.
  if (groups.length === 0) {
    const flat = /** @type {DesignColor[]} */ (
      collectBullets(section.lines)
        .map((b) => parseColorBullet(b))
        .filter(Boolean)
    );
    if (flat.length) {
      for (const p of flat) {
        if (p.name && ROLE_KEYWORDS.test(p.name)) {
          groups.push({ role: /** @type {string} */ (p.name), colors: [p] });
        } else {
          const fallback = groups.find((g) => g.role === 'Palette');
          if (fallback) fallback.colors.push(p);
          else groups.push({ role: 'Palette', colors: [p] });
        }
      }
    }
  }

  return {
    subtitle: section.subtitle,
    description: description || null,
    groups,
    rules: extractNamedRules(section.lines),
  };
}

/**
 * @param {string} bullet
 * @returns {DesignColor | null}
 */
function parseColorBullet(bullet) {
  const text = bullet.trim();

  // Case 1 (Impeccable): **Name** (value-with-maybe-nested-parens): description
  const bold = text.match(/^\*\*(.+?)\*\*\s*(.*)$/);
  const boldRest = bold ? /** @type {string} */ (bold[2]) : '';
  if (bold && boldRest.startsWith('(')) {
    const value = extractParenGroup(boldRest);
    if (value !== null) {
      const after = boldRest.slice(value.length + 2).trimStart();
      if (after.startsWith(':')) {
        return buildColor(/** @type {string} */ (bold[1]), value, after.slice(1).trim());
      }
    }
  }

  // Case 2 (Stitch): **Name (values):** description   — value embedded in bold.
  const stitch = text.match(/^\*\*([^*]+?)\s*\(([^)]+)\):\*\*\s*(.*)$/);
  if (stitch) {
    return buildColor(
      /** @type {string} */ (stitch[1]).trim(),
      /** @type {string} */ (stitch[2]),
      /** @type {string} */ (stitch[3])
    );
  }

  // Case 3: bullet without bold, just hex/oklch inside.
  const values = collectColorValues(text);
  if (values.length) {
    return buildColor(null, values.join(' to '), text);
  }
  return null;
}

/**
 * @param {string} s
 * @returns {string | null}
 */
function extractParenGroup(s) {
  if (s[0] !== '(') return null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return s.slice(1, i);
    }
  }
  return null;
}

/**
 * @param {string | null} name
 * @param {string} rawValue
 * @param {string | null} description
 * @returns {DesignColor}
 */
function buildColor(name, rawValue, description) {
  const values = collectColorValues(rawValue);
  const primary = values[0] ?? rawValue.trim();
  return {
    name: name ? stripBold(name).trim() : null,
    value: primary,
    valueRange: values.length > 1 ? values : null,
    format: detectFormat(primary),
    description: stripBold(description || '').trim() || null,
  };
}

/**
 * @param {string} s
 * @returns {string[]}
 */
function collectColorValues(s) {
  /** @type {string[]} */
  const out = [];
  s.replace(HEX_RE, (v) => {
    out.push(v);
    return v;
  });
  s.replace(OKLCH_RE, (v) => {
    out.push(v);
    return v;
  });
  return out;
}

/** @param {string | null | undefined} v */
function detectFormat(v) {
  if (!v) return 'unknown';
  if (v.startsWith('#')) return 'hex';
  if (/^oklch/i.test(v)) return 'oklch';
  if (/^rgb/i.test(v)) return 'rgb';
  return 'unknown';
}

/** @param {Section | undefined} section */
function extractTypography(section) {
  if (!section) return null;
  const text = section.lines.join('\n');

  /** @type {Record<string, { family: string, fallback: string | null, purpose?: string }>} */
  const fonts = {};
  // Pattern A: **Display Font:** Family (with fallback)
  const fontLineRe = /\*\*([\w\s/]+?)Font:\*\*\s*([^\n(]+?)(?:\s*\(with\s+([^)]+)\))?\s*$/gm;
  /** @type {RegExpExecArray | null} */
  let fm;
  while ((fm = fontLineRe.exec(text)) !== null) {
    const rawRole = /** @type {string} */ (fm[1]).trim().toLowerCase().replace(/\s+/g, '-');
    const role = normalizeFontRole(rawRole) || 'display';
    fonts[role] = {
      family: /** @type {string} */ (fm[2]).trim(),
      fallback: fm[3] ? fm[3].trim() : null,
    };
  }

  // Pattern B (Stitch): *   **Display & Headlines (Noto Serif):** description
  if (Object.keys(fonts).length === 0) {
    const stitchRe = /\*\*([\w\s&/]+?)\s*\(([^)]+)\):\*\*\s*(.+)/g;
    /** @type {RegExpExecArray | null} */
    let sm;
    while ((sm = stitchRe.exec(text)) !== null) {
      const rawRole = /** @type {string} */ (sm[1])
        .trim()
        .toLowerCase()
        .replace(/\s*&\s*/g, '-')
        .replace(/\s+/g, '-');
      const role = normalizeFontRole(rawRole) || rawRole;
      fonts[role] = {
        family: /** @type {string} */ (sm[2]).trim(),
        fallback: null,
        purpose: /** @type {string} */ (sm[3]).trim(),
      };
    }
  }

  // Character paragraph — either a **Character:** label, or fall back to the
  // first free paragraph under the section header (Stitch style).
  const characterMatch = text.match(/\*\*Character:\*\*\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\n|\n###|\n##|$)/);
  /** @type {string | null} */
  let character = characterMatch
    ? /** @type {string} */ (characterMatch[1]).replace(/\n/g, ' ').trim()
    : null;
  if (!character) {
    const paragraphs = collectParagraphs(section.lines).filter(
      (p) => !/^\*\*[\w\s/&]+Font/i.test(p) && !/^\*\*[\w\s/&]+\([^)]+\)/.test(p)
    );
    if (paragraphs.length) character = /** @type {string} */ (paragraphs[0]);
  }

  // Hierarchy bullets under ### Hierarchy
  const subs = splitSubsections(section.lines);
  /** @type {ReturnType<typeof parseTypeBullet>[]} */
  let hierarchy = [];
  const hierSub = subs.find((s) => s.name && /hierarch/i.test(s.name));
  if (hierSub) {
    const bullets = collectBullets(hierSub.lines);
    hierarchy = bullets.map(parseTypeBullet).filter(Boolean);
  }

  return {
    subtitle: section.subtitle,
    fonts,
    character,
    hierarchy,
    rules: extractNamedRules(section.lines),
  };
}

/**
 * @param {string} raw
 * @returns {string | null}
 */
function normalizeFontRole(raw) {
  // Canonical roles the panel cares about: display, body, label, mono.
  // Stitch often writes compound roles like "display-&-headlines" or "ui-&-body"
  // — collapse them to the first canonical role present.
  const tokens = raw.split(/[-/&\s]+/).filter(Boolean);
  const priority = ['display', 'headline', 'body', 'ui', 'label', 'mono'];
  /** @type {Record<string, string | undefined>} */
  const canonical = { headline: 'display', ui: 'body' };
  for (const p of priority) {
    if (tokens.includes(p)) return canonical[p] || p;
  }
  return null;
}

/** @param {string} bullet */
function parseTypeBullet(bullet) {
  // - **Display** (family, weight 300, italic, clamp(...), line-height 1): purpose
  const m = bullet.match(/^\*\*(.+?)\*\*\s*\(([^)]+)\):\s*(.*)$/);
  if (!m) return null;
  const name = /** @type {string} */ (m[1]).trim();
  const specs = /** @type {string} */ (m[2]).split(',').map((s) => s.trim());
  return {
    name,
    specs,
    purpose: stripBold(m[3] || '').trim() || null,
  };
}

/** @param {Section | undefined} section */
function extractElevation(section) {
  if (!section) return null;
  const subs = splitSubsections(section.lines);

  const description =
    collectParagraphs(/** @type {Subsection} */ (subs[0]).lines).join(' ') || null;

  /** @type {DesignShadow[]} */
  const shadows = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {DesignShadow} entry */
  const dedupe = (entry) => {
    const key = (entry.name || '') + '::' + entry.value;
    if (seen.has(key)) return;
    seen.add(key);
    shadows.push(entry);
  };

  for (const b of collectBullets(section.lines)) {
    const parsed = parseShadowBullet(b);
    if (parsed) dedupe(parsed);
  }

  // Fallback: extract shadows written inline in prose. Stitch style is
  //   "...use an extra-diffused shadow: `box-shadow: 0 12px 40px rgba(...)`."
  for (const p of collectParagraphs(section.lines)) {
    for (const inline of extractInlineShadows(p)) dedupe(inline);
  }
  for (const b of collectBullets(section.lines)) {
    for (const inline of extractInlineShadows(b)) dedupe(inline);
  }

  return {
    subtitle: section.subtitle,
    description,
    shadows,
    rules: extractNamedRules(section.lines),
  };
}

/**
 * @param {string} text
 * @returns {DesignShadow[]}
 */
function extractInlineShadows(text) {
  // Find `box-shadow: ...` anywhere in prose and capture the value. Work on the
  // raw string so it handles both backtick-fenced and unfenced variants.
  /** @type {DesignShadow[]} */
  const out = [];
  const re = /box-shadow\s*:\s*([^`;\n]+)/gi;
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = /** @type {string} */ (m[1]).replace(/[`.)]+$/, '').trim();
    if (!value) continue;
    // Name heuristic: the noun immediately before the shadow phrase.
    // e.g. "an extra-diffused shadow: ..." -> "extra-diffused shadow"
    const before = text.slice(0, m.index);
    const nameMatch = before.match(/\b([A-Za-z][A-Za-z\- ]{2,40})\s+shadow\b[^A-Za-z0-9]*$/i);
    /** @type {string | null} */
    let name = null;
    if (nameMatch) {
      const stripped = /** @type {string} */ (nameMatch[1])
        .replace(/^(?:use|using|apply|applying|is|are|looks? like)\s+/i, '')
        .replace(/^(?:a|an|the)\s+/i, '')
        .trim();
      if (stripped) {
        name =
          stripped.charAt(0).toUpperCase() + stripped.slice(1) + ' shadow';
      }
    }
    out.push({
      name,
      value,
      purpose: null,
    });
  }
  return out;
}

/**
 * @param {string} bullet
 * @returns {DesignShadow | null}
 */
function parseShadowBullet(bullet) {
  // - **Name** (`box-shadow: value`): purpose
  // - **Name** (`value`): purpose
  // Only accept if the paren content looks like a shadow value (contains px,
  // rem, rgba, or box-shadow). This filters out `**Rule Name:**` bullets.
  const m = bullet.match(/^\*\*(.+?)\*\*\s*\(`?([^`]+?)`?\):\s*(.*)$/);
  if (!m) return null;
  const rawValue = /** @type {string} */ (m[2]).replace(/^box-shadow:\s*/i, '').trim();
  const looksLikeShadow =
    /box-shadow|rgba?\(|\bpx\b|\brem\b|^-?\d+\s/i.test(rawValue) &&
    /\d/.test(rawValue);
  if (!looksLikeShadow) return null;
  const name = stripBold(/** @type {string} */ (m[1])).trim();
  return {
    name,
    value: rawValue,
    purpose: stripBold(m[3] || '').trim() || null,
  };
}

/** @param {Section | undefined} section */
function extractComponents(section) {
  if (!section) return null;
  const subs = splitSubsections(section.lines);
  /** @type {{ name: string, description: string | null, properties: Record<string, string>, variants: { name: string, description: string }[] }[]} */
  const components = [];

  for (const sub of subs.slice(1)) {
    if (!sub.name) continue;

    const bullets = collectBullets(sub.lines);
    const paragraphs = collectParagraphs(sub.lines);

    /** @type {{ name: string, description: string }[]} */
    const variants = [];
    /** @type {Record<string, string>} */
    const properties = {};

    for (const b of bullets) {
      // - **Key:** value
      const m = b.match(/^\*\*(.+?):?\*\*:?\s*(.+)$/);
      if (m) {
        const key = stripBold(/** @type {string} */ (m[1])).trim();
        const value = stripBold(/** @type {string} */ (m[2])).trim();
        // Heuristic: "Primary", "Secondary", "Hover", "Focus" etc are variants;
        // "Shape", "Background", "Padding" are properties.
        const head = /** @type {string} */ (key.split(/[\s/]/)[0]);
        if (
          /^(primary|secondary|tertiary|ghost|hover|focus|active|disabled|default|error|selected|unselected|state)$/i.test(head)
        ) {
          variants.push({ name: key, description: value });
        } else {
          properties[key.toLowerCase()] = value;
        }
      }
    }

    components.push({
      name: /** @type {string} */ (sub.name),
      description: paragraphs.join(' ') || null,
      properties,
      variants,
    });
  }

  return {
    subtitle: section.subtitle,
    components,
  };
}

/** @param {Section | undefined} section */
function extractDosDonts(section) {
  if (!section) return null;
  const subs = splitSubsections(section.lines);
  /** @type {string[]} */
  const dos = [];
  /** @type {string[]} */
  const donts = [];

  for (const sub of subs.slice(1)) {
    if (!sub.name) continue;
    const subName = normalizeApostrophes(sub.name);
    const bullets = collectBullets(sub.lines).map((b) => stripBold(b).trim());
    if (/^do'?t?:?$/i.test(subName) || /^do:?$/i.test(subName)) {
      dos.push(...bullets);
    } else if (/^don'?t:?$/i.test(subName)) {
      donts.push(...bullets);
    }
  }

  // Classify by bullet prefix as a backup (catches loose bullets outside H3 wrappers)
  for (const b of collectBullets(section.lines)) {
    const stripped = normalizeApostrophes(stripBold(b).trim());
    if (/^don'?t\b/i.test(stripped)) {
      if (!donts.some((d) => normalizeApostrophes(d) === stripped)) donts.push(stripped);
    } else if (/^do\b/i.test(stripped)) {
      if (!dos.some((d) => normalizeApostrophes(d) === stripped)) dos.push(stripped);
    }
  }

  return { dos, donts };
}

// ---------- Coverage assessment ----------

/** @param {ReturnType<typeof parseDesignMd>} model */
function assessCoverage(model) {
  /** @type {Record<string, unknown>} */
  const report = {};

  report['overview'] = model.overview
    ? {
        northStar: Boolean(model.overview.creativeNorthStar),
        philosophy: model.overview.philosophy.length > 0,
        keyCharacteristics: model.overview.keyCharacteristics.length,
      }
    : 'missing';

  report['colors'] = model.colors
    ? {
        groups: model.colors.groups.length,
        totalColors: model.colors.groups.reduce((n, g) => n + g.colors.length, 0),
        rules: model.colors.rules.length,
      }
    : 'missing';

  report['typography'] = model.typography
    ? {
        fonts: Object.keys(model.typography.fonts).length,
        hierarchyEntries: model.typography.hierarchy.length,
        character: Boolean(model.typography.character),
        rules: model.typography.rules.length,
      }
    : 'missing';

  report['elevation'] = model.elevation
    ? {
        shadows: model.elevation.shadows.length,
        rules: model.elevation.rules.length,
        description: Boolean(model.elevation.description),
      }
    : 'missing';

  report['components'] = model.components
    ? {
        count: model.components.components.length,
        variantTotal: model.components.components.reduce((n, c) => n + c.variants.length, 0),
      }
    : 'missing';

  report['dosDonts'] = model.dosDonts
    ? {
        dos: model.dosDonts.dos.length,
        donts: model.dosDonts.donts.length,
      }
    : 'missing';

  return report;
}

// ---------- Main ----------

/** @param {string} md */
export function parseDesignMd(md) {
  const { frontmatter, body } = parseFrontmatter(md);
  const { title, sections } = splitSections(body);
  return {
    schemaVersion: 2,
    title,
    frontmatter,
    overview: extractOverview(sections['Overview']),
    colors: extractColors(sections['Colors']),
    typography: extractTypography(sections['Typography']),
    elevation: extractElevation(sections['Elevation']),
    components: extractComponents(sections['Components']),
    dosDonts: extractDosDonts(sections["Do's and Don'ts"]),
  };
}

export { assessCoverage };
