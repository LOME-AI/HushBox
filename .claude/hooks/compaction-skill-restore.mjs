// Shared vocabulary for the compaction skill-restore hook pair
// (precompact-skill-state.mjs writes the marker, sessionstart-skill-restore.mjs consumes it).
//
// Auto-compaction re-attaches each invoked skill's rendered SKILL.md but keeps only a fixed
// character budget of it, so a large skill loses its tail — for the subagent-driven-* skills that
// is the half carrying the standing rules. These hooks re-append exactly the severed bytes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Only skills that govern a whole session are restored. A one-shot skill re-injected after
// compaction reads as a pending task and gets re-executed, duplicating its side effects.
export const STICKY_SKILLS = [
  'subagent-driven-dev',
  'subagent-driven-docket',
  'subagent-driven-e2e-green',
];

export const TRUNCATION_MARKER = '[... skill content truncated for compaction';

// Where the platform cuts the rendered skill, used only until a transcript supplies the observed
// value. Measured identical across sessions whose rendered content differed by hundreds of
// characters of substituted arguments, so the budget counts characters and ignores content.
export const SEED_CUT = 19900;

// A cut inferred from anything but this skill's own truncated copy starts the tail this many
// characters early: overlap re-reads a paragraph, a shortfall silently loses instructions.
export const UNCALIBRATED_OVERLAP = 250;

// The host inlines a hook's additionalContext only while its length is at most this, and writes a
// longer one to a file that reaches the model as a 2000-character preview — a fragment of the skill
// delivered under a success message. Read from the CLI's own constant, so the whole assembled note is
// measured against it rather than the tail alone.
export const HOOK_CONTEXT_LIMIT = 10000;

// SessionStart slots the restore is registered on. Each hook invocation is measured against the
// limit separately, so a tail larger than one note is delivered whole across consecutive slots
// instead of degrading to an instruction the model has to act on. Four covers the largest skill.
export const TAIL_SLOTS = 4;

// Enough trailing kept text to locate the cut unambiguously in the body. Matching on text rather
// than on the character offset keeps the restore independent of the preamble's base-directory
// string and of the substituted arguments, neither of which a hook can reproduce byte-for-byte.
export const ANCHOR_CHARS = 240;

export function markerPath(sessionId) {
  const safe = String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(os.tmpdir(), `hushbox-compact-skill-${safe}.json`);
}

export function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
}

export function skillDir(root, name) {
  return path.join(root, '.claude', 'skills', name);
}

export function skillFilePath(root, name) {
  return path.join(skillDir(root, name), 'SKILL.md');
}

export async function readStdinJson() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
}

/** Last `bytes` of a file, with the leading partial line dropped. */
export function readTailLines(file, bytes) {
  const { size } = fs.statSync(file);
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift();
  return lines;
}

/** SKILL.md body: frontmatter removed and the leading blank line stripped, as the platform renders it. */
export function renderedBody(text) {
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return (fm ? text.slice(fm[0].length) : text).replace(/^\s*\n/, '');
}

/**
 * The skill exactly as compaction re-attaches it: a base-directory preamble, then the body with the
 * invocation's arguments substituted. Byte-identical reconstruction is what makes the cut offset
 * meaningful — a one-character drift here shifts every offset past it.
 */
export function renderSkill({ body, dir, args }) {
  return `Base directory for this skill: ${dir}\n\n${body.replace('$ARGUMENTS', args ?? '')}`;
}

/** A re-attached copy's surviving text, right-trimmed of the separator the marker is appended after. */
export function keptText(content) {
  const at = content.indexOf(TRUNCATION_MARKER);
  if (at === -1) return null;
  return content.slice(0, at).replace(/\s+$/, '');
}
