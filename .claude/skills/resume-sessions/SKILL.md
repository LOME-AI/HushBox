---
name: resume-sessions
description: Map the user's shorthand labels for dead Claude Code sessions to the exact `claude --resume` command each one needs, including the model, context variant, and effort it was running when it died. Invoke after a batch of sessions is lost to a host restart or crash.
disable-model-invocation: true
argument-hint: <label, label, ...>
---

# Resume Sessions

Resolve each label the user gives to the session it names and produce one resume command
per label. The whole deliverable is one chat message; this skill writes no files and
modifies nothing.

## Labels

$ARGUMENTS

The labels are the user's private shorthand for what each session was doing. Nothing in a
session file carries them, so every label is resolved by evidence from the transcript —
never by matching the label's text.

## Hard Constraints

- Read-only throughout: never write, move, or truncate a session file.
- A session id is a version-4 UUID and safe to print. Everything else the run emits is
  bound by `docs/AGENT-RULES.md` §Privacy: dates at `YYYY-MM-DD` resolution, never a clock
  reading; "the repo root" rather than an absolute path; a description of a finding
  rather than a pasted transcript excerpt.
- Never resolve an ambiguity silently. A label that fits two sessions is reported with the
  distinguishing evidence for each; a label that fits none is reported as unmatched.

## Step 1 — Locate the Session Store

Sessions live under `~/.claude/projects/<encoded-cwd>/`, one `<session-id>.jsonl` per
session. The directory name is the session's working directory with every `/` replaced by
`-`. Sibling directories hold other projects and worktrees; start with the directory for
the repo root and widen to siblings only when a label goes unmatched.

Those directory names begin with `-`, which `ls` reads as a flag. Prefix the path with
`./` or use `find`/glob.

## Step 2 — Extract One Record Per File

One pass with a small script (`python3`, `node` and `jq` are all available), collecting
per file:

- File mtime — for recency ordering only, never as a matching signal on its own.
- `cwd` and `gitBranch` from any entry. The resume command must be run from that `cwd`.
- The first and last non-meta user message text. Skip entries whose text starts with `<`,
  and skip the `[Request interrupted by user]` and "This session is being continued…"
  markers — they are not identity.
- Every `<command-name>` / `<command-args>` pair in user entries. The slash command plus
  its argument is the strongest identity signal: it is usually the sentence the user
  typed to start the work. The command-name pattern must admit digits — `/debug-e2e`
  contains one.
- For main-chain assistant entries only (`isSidechain` falsy): `message.model` and the
  entry's `effort`. Subagent entries carry their own model and must be excluded. Skip
  assistant entries whose model is `<synthetic>`; they are placeholders, not turns the
  session ran.
- Every main-chain model string that carries a context-window suffix, in order. The
  selected model has the form `<full-model-id>[1m]` when the session ran on the extended
  context window; `message.model` is the API-normalized id and never carries the suffix,
  so a 1M-context session and a default-context session are indistinguishable there.
  Two fields do carry it: `attachment.identity.modelId`, and `toolUseResult.resolvedModel`
  on an Agent-tool result — the subagent's resolved model, which equals the parent's
  only when that spawn did not override the model, so an Agent spawn carrying an
  explicit model override is not evidence about the parent.

## Step 3 — Match Each Label

Evidence, in order of preference:

1. The skill invocation and its args.
2. The opening prompt.
3. Artifacts named in the transcript — file paths, blog slugs, run directories.

## Step 4 — Find the Live Tip

Resuming a session mints a new id that carries the old history, so one label can own
several files. Group candidates by opening user message and take the newest. Sessions
whose first message is an interrupt marker collide spuriously under that grouping —
confirm distinctness by the skill args before treating two files as one thread.

## Step 5 — Read Model, Context Variant and Effort Off the Final Turn

Model and effort are the last main-chain values, not the majority: sessions switch
mid-run, in either direction and more than once. Take both off the final main-chain
assistant message. When a session switched, report the path it took alongside the final
value — the user may want to override the final value rather than restore it.

The context variant is read separately, because `message.model` drops it. Take the most
recent main-chain suffix-bearing string (Step 2) whose family matches the final model:
if it ends in `[1m]`, the command carries the full id with that suffix; a transcript with
no `[1m]` string at all was on the default context window and takes the plain id.

## Step 6 — Deliver

Everything below goes out as one message.

1. One `bash` block, one command per label, each preceded by a comment carrying the label
   and a one-line identity for the session (the skill invoked, or the task in the user's
   own framing):

   ```bash
   # <label> — <identity>
   claude --dangerously-skip-permissions --model '<model-id>' --effort <level> --resume <session-id>
   ```

   `--model` takes the full id from the transcript with its context suffix when Step 5
   found one (for example `'claude-opus-5[1m]'`, `'claude-fable-5-1'`), never the alias
   form (`opus[1m]`), which drifts to the newest model in its family. Always
   single-quote the value: square brackets are shell glob metacharacters, and zsh fails
   an unquoted `[1m]` with a no-matches error before `claude` runs. `--effort` takes one
   of `low`, `medium`, `high`, `xhigh`, `max`. `--dangerously-skip-permissions` is
   always wanted for these.

2. A note that every command must be run from its session's `cwd`.
3. A table of every session that switched model or effort mid-run: the path through the
   session and what it died on.
4. Ambiguities and unmatched labels, stated plainly.
