#!/usr/bin/env node
// PreToolUse hook for mcp__chrome-devtools__take_screenshot.
//
// chrome-devtools-mcp has no server-level output-dir flag (unlike @playwright/mcp's
// --output-dir), and its take_screenshot writes `filePath` relative to the server cwd —
// i.e. straight into the repo root. This hook redirects any escaping filePath into the
// already-gitignored .chrome-devtools-mcp/ scratch dir so screenshots never litter the
// worktree. Paths already inside the scratch dir, and the no-filePath case (image returned
// inline, nothing written), are left untouched.
import path from 'node:path';

const SCRATCH = '.chrome-devtools-mcp';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let data;
try {
  data = JSON.parse(raw);
} catch {
  // Malformed input must never block the tool; defer to default allow.
  process.exit(0);
}

const toolInput = data.tool_input ?? {};
const filePath = toolInput.filePath;

// No filePath => chrome-devtools attaches the image to the response; nothing is written.
if (typeof filePath !== 'string' || filePath.length === 0) process.exit(0);

const cwd = data.cwd || process.cwd();
const scratchAbs = path.resolve(cwd, SCRATCH);
const targetAbs = path.resolve(cwd, filePath);

// Already contained in the scratch dir: leave it alone.
if (targetAbs === scratchAbs || targetAbs.startsWith(scratchAbs + path.sep)) {
  process.exit(0);
}

const rewritten = path.join(SCRATCH, path.basename(filePath));
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...toolInput, filePath: rewritten },
    },
  }),
);
