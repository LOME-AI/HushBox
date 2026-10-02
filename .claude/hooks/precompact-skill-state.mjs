#!/usr/bin/env node
// PreCompact hook: record which session-governing skill was in use, with what arguments, and where
// the platform cut its re-attached copy last time — for the SessionStart (source=compact) hook.
//
// All three facts are gathered here because this event's transcript is the complete pre-compaction
// record and is already flushed. The copy this compaction produces is not on disk at SessionStart:
// it is written as part of assembling the post-compaction prompt, which happens after that hook
// returns, so no amount of waiting there can observe it.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import {
  STICKY_SKILLS,
  ANCHOR_CHARS,
  keptText,
  markerPath,
  projectDir,
  readStdinJson,
  readTailLines,
  skillDir,
  skillFilePath,
} from './compaction-skill-restore.mjs';

const COMMAND_NAME = /<command-name>\/([\w-]+)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const SIBLING_TRANSCRIPTS = 10;
const SIBLING_TAIL_BYTES = 4 * 1024 * 1024;

function messageText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' ? (b.text ?? '') : '')).join('');
}

/** Sticky-skill invocations in one transcript entry, each with the arguments it was invoked with. */
function invocationsIn(entry) {
  const found = [];
  const content = entry?.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name === 'Skill' && block.input?.skill) {
        found.push({ name: block.input.skill, args: block.input.args ?? '' });
      }
    }
  }
  const text = messageText(entry);
  const name = COMMAND_NAME.exec(text);
  if (name) found.push({ name: name[1], args: COMMAND_ARGS.exec(text)?.[1] ?? '' });
  return found.filter((f) => STICKY_SKILLS.includes(f.name));
}

/** Truncations observed in one transcript line's re-attachment record, one per skill it carries. */
function cutsIn(line) {
  if (!line.includes('"invoked_skills"')) return [];
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  const out = [];
  for (const skill of entry?.attachment?.skills ?? []) {
    const kept = keptText(skill?.content ?? '');
    if (kept !== null) {
      out.push({ name: skill.name, cut: kept.length, anchor: kept.slice(-ANCHOR_CHARS) });
    }
  }
  return out;
}

/**
 * The most recent cut this project has observed, preferring one measured on `skill` itself.
 * Sibling transcripts are consulted so a session that has not yet compacted still starts calibrated.
 */
function calibrateFromSiblings(transcript, skill) {
  let dir;
  try {
    dir = path.dirname(transcript);
  } catch {
    return null;
  }
  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && path.join(dir, f) !== transcript)
      .map((f) => path.join(dir, f))
      .map((f) => ({ f, at: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, SIBLING_TRANSCRIPTS);
  } catch {
    return null;
  }
  let other = null;
  for (const { f } of files) {
    let lines;
    try {
      lines = readTailLines(f, SIBLING_TAIL_BYTES);
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      for (const seen of cutsIn(lines[i])) {
        // Another session's copy was rendered with that session's arguments, so its text anchor can
        // sit at a different content offset than this session's cut; only the budget carries over.
        if (seen.name === skill) return { cut: seen.cut, anchor: null, cutSource: 'other-session' };
        other ??= { cut: seen.cut, anchor: null, cutSource: 'other-skill' };
      }
    }
  }
  return other;
}

let input;
try {
  input = await readStdinJson();
} catch {
  // Malformed input must never block compaction.
  process.exit(0);
}

// The marker is this hook's to create and destroy: a compaction with no sticky skill must not leave
// the previous one in place for SessionStart to restore. Clearing it here rather than at read time
// also keeps the parallel slice invocations off a file one of them would be deleting.
const marker = markerPath(input.session_id);
fs.rmSync(marker, { force: true });

try {
  const transcript = input.transcript_path;
  if (!transcript || !fs.existsSync(transcript)) process.exit(0);

  // Recency by line position, never by the order of the invoked_skills attachment: that array
  // has been observed disagreeing with actual invocation order.
  let winner = null;
  let anySeen = null;
  const seenBySkill = new Map();
  let lineNo = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(transcript, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    lineNo += 1;
    for (const seen of cutsIn(line)) {
      seenBySkill.set(seen.name, seen);
      anySeen = seen;
    }
    if (!line.includes('"Skill"') && !line.includes('<command-name>')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const found of invocationsIn(entry)) winner = { ...found, at: lineNo };
  }

  // No sticky skill was in use: leave no marker, so the SessionStart hook injects nothing.
  if (!winner) process.exit(0);

  const own = seenBySkill.get(winner.name);
  const calibration =
    (own ? { cut: own.cut, anchor: own.anchor, cutSource: 'same-skill' } : null) ??
    calibrateFromSiblings(transcript, winner.name) ??
    (anySeen ? { cut: anySeen.cut, anchor: null, cutSource: 'other-skill' } : null);

  const root = projectDir(input);
  fs.writeFileSync(
    marker,
    JSON.stringify({
      skill: winner.name,
      skillPath: skillFilePath(root, winner.name),
      dir: skillDir(root, winner.name),
      args: winner.args,
      cut: calibration?.cut ?? null,
      anchor: calibration?.anchor ?? null,
      cutSource: calibration?.cutSource ?? null,
      trigger: input.trigger ?? null,
    }),
    'utf8'
  );
} catch (error) {
  process.stderr.write(`precompact-skill-state: ${error.message}\n`);
}

process.exit(0);
