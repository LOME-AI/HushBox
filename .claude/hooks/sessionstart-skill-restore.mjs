#!/usr/bin/env node
// SessionStart (source=compact) hook: re-append the bytes compaction cut off the end of the
// session-governing skill, as recorded by precompact-skill-state.mjs.
//
// SessionStart is the only compaction-adjacent event that can inject context — PostCompact has no
// decision control — and additionalContext lands before the first prompt after the summary. The
// tail is reconstructed from SKILL.md and the recorded cut rather than read back from the
// transcript, because this compaction's re-attached copy is written only after this hook returns.
//
// Registered once per slot, each invocation passed its slot index; a tail too long for one note is
// split across the slots, since the host measures each hook's output on its own.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HOOK_CONTEXT_LIMIT,
  SEED_CUT,
  TAIL_SLOTS,
  UNCALIBRATED_OVERLAP,
  markerPath,
  readStdinJson,
  renderSkill,
  renderedBody,
} from './compaction-skill-restore.mjs';

const ANCHOR_LENGTH = 120;

// Least of a slot's budget a heading-aligned chunk may fill before the alignment is abandoned. A
// part that opens on a heading reads as a section; one that gives up half its slot to reach a
// heading costs a slot the largest skills do not have to spare.
const MIN_HEADING_FILL = 0.7;

function tellHuman(line) {
  return `\n\nBefore your next action, tell the human in one line: "${line}"`;
}

// Re-attachment is not guaranteed: a compaction that drops the skill entirely leaves nothing for a
// tail to continue, and only the model can see whether a copy arrived.
const EVICTION_CHECK =
  `\n\nFirst confirm a copy of this skill actually appears earlier in your context. If none does, ` +
  `compaction dropped it entirely: read the whole file at \`{path}\` before continuing, and say so ` +
  `instead of the line below.`;

function withChecks(body, path, humanLine) {
  return body + EVICTION_CHECK.replace('{path}', path) + tellHuman(humanLine);
}

/**
 * One slot's note. Slot 0 carries the framing and the reporting instruction; later slots carry only
 * their labelled chunk, so a slot arriving out of order still says where it belongs.
 */
function sliceNote(state, { index, total, chunk, tailLength }) {
  const label = `PART ${index + 1} OF ${total}`;
  const body = `--- BEGIN RESTORED TAIL ${label} ---\n${chunk}\n--- END RESTORED TAIL ${label} ---`;
  if (index > 0) return body;
  const parts = total === 1 ? '' : `, split across ${total} parts delivered separately`;
  return withChecks(
    `The \`${state.skill}\` skill body in your context was truncated by compaction. Below is the ` +
      `exact remainder of its SKILL.md${parts}, continuing from where that copy stops ` +
      `mid-sentence. Treat every part as the skill's standing instructions.\n\n${body}`,
    state.skillPath,
    `Compaction recovery: ${state.skill} fully restored — ${tailLength} chars of truncated tail ` +
      `re-appended${total === 1 ? '' : ` across ${total} parts`}, entire skill correctly preserved ` +
      `in context.`
  );
}

function fetchNote(state, tail, line) {
  const where = line === null ? 'the whole file' : `from line ${line} to the end`;
  return withChecks(
    `The \`${state.skill}\` skill body in your context was truncated by compaction, and its ` +
      `missing tail (${tail.length} chars) is too large to inject here. Before your next action, ` +
      `Read \`${state.skillPath}\` ${where} and treat it as part of the skill's standing ` +
      `instructions.`,
    state.skillPath,
    `Compaction recovery: ${state.skill} tail is ${tail.length} chars, over what the hook slots ` +
      `hold — restoring it by reading SKILL.md ${where}.`
  );
}

function intactNote(state) {
  return withChecks(
    `The \`${state.skill}\` skill governs this session and is short enough that compaction kept ` +
      `it whole; nothing needs restoring.`,
    state.skillPath,
    `Compaction recovery: ${state.skill} survived compaction intact — no tail restore needed.`
  );
}

function unreadableNote(state) {
  return (
    `Compaction truncated the \`${state.skill}\` skill body in your context and its SKILL.md could ` +
    `not be read at \`${state.skillPath}\`, so the missing tail could not be restored.` +
    tellHuman(
      `Compaction recovery FELL BACK for ${state.skill} — SKILL.md unreadable, tail not restored; ` +
        `re-invoke the skill manually.`
    )
  );
}

/** 1-based line in `raw` where the severed tail begins, or null when the tail is not verbatim file text. */
function tailLine(raw, tail) {
  const anchor = tail.slice(0, ANCHOR_LENGTH);
  const at = raw.indexOf(anchor);
  if (at === -1) return null;
  return raw.slice(0, at).split('\n').length;
}

/**
 * Where the severed tail begins in `rendered`. The recorded anchor is the last text the platform
 * kept, so matching it locates the cut exactly; the character budget is the fallback, and is read
 * short by an overlap whenever it was measured on something other than this skill in this session.
 */
function tailStart(state, rendered) {
  if (state.anchor) {
    const at = rendered.lastIndexOf(state.anchor);
    if (at !== -1) return at + state.anchor.length;
  }
  const cut = typeof state.cut === 'number' && state.cut > 0 ? state.cut : SEED_CUT;
  if (rendered.length <= cut) return rendered.length;
  return state.cutSource === 'same-skill' ? cut : Math.max(0, cut - UNCALIBRATED_OVERLAP);
}

/**
 * The tail cut into one chunk per slot it needs, or null when the slots cannot hold it. Each slot's
 * budget is its own note measured empty, since slot 0 carries framing the others do not; a chunk
 * ends at the heading its budget reaches, falling back to a line end when that wastes the slot.
 */
export function planSlices(state, tail) {
  for (let total = 1; total <= TAIL_SLOTS; total += 1) {
    const chunks = [];
    let pos = 0;
    for (let index = 0; index < total; index += 1) {
      const empty = sliceNote(state, { index, total, chunk: '', tailLength: tail.length });
      const budget = HOOK_CONTEXT_LIMIT - empty.length;
      if (budget <= 0) break;
      let end = Math.min(tail.length, pos + budget);
      if (end < tail.length) {
        const found = tail.lastIndexOf('\n\n#', end - 2);
        const heading = found === -1 ? -1 : found + 2;
        const line = tail.lastIndexOf('\n', end);
        if (heading > pos && heading - pos >= budget * MIN_HEADING_FILL) end = heading;
        else if (line > pos) end = line + 1;
      }
      chunks.push(tail.slice(pos, end));
      pos = end;
      if (pos >= tail.length) break;
    }
    if (pos >= tail.length) return chunks;
  }
  return null;
}

export function buildContext(state, index) {
  let raw;
  try {
    raw = fs.readFileSync(state.skillPath, 'utf8');
  } catch {
    return index === 0 ? unreadableNote(state) : null;
  }

  const rendered = renderSkill({ body: renderedBody(raw), dir: state.dir, args: state.args });
  const tail = rendered.slice(tailStart(state, rendered));
  if (tail.trim() === '') return index === 0 ? intactNote(state) : null;

  const chunks = planSlices(state, tail);
  if (chunks === null) return index === 0 ? fetchNote(state, tail, tailLine(raw, tail)) : null;
  if (index >= chunks.length) return null;
  return sliceNote(state, {
    index,
    total: chunks.length,
    chunk: chunks[index],
    tailLength: tail.length,
  });
}

async function main() {
  let input;
  try {
    input = await readStdinJson();
  } catch {
    return;
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(markerPath(input.session_id), 'utf8'));
  } catch {
    // No sticky skill was in use at the last compaction: inject nothing.
    return;
  }

  try {
    const context = buildContext(state, Number.parseInt(process.argv[2] ?? '0', 10) || 0);
    if (context !== null) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
        })
      );
    }
  } catch (error) {
    process.stderr.write(`sessionstart-skill-restore: ${error.message}\n`);
  }
}

// Reading stdin at import time would hang any caller that loads this file for its exports, and
// exiting would kill it, so the hook body runs only when this file is the process entry point.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
  process.exit(0);
}
