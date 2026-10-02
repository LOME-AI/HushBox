# Audit findings (docs/audits)

One directory per audit run. Each finding is a file: YAML frontmatter holding mutable
state, a markdown body that no tool rewrites on its own. Three different writers touch the same
file — the audit agent that creates it, the human who rules on it, the implementation
agent that works it — and two of them are language models, so the format below is a
contract rather than a convention. Read it before writing anything under this directory.

The console and CLI that read and write this format are `pnpm docket`. `pnpm docket --validate` checks the live corpus against the
structural invariants below, and runs in the pre-push gate, so a corpus that violates them
refuses the push.

## Layout

```
docs/audits/
  CLAUDE.md              this contract
  <YYYY-MM-DD>/
    audit.md             the run header
    findings/<ID>.md     one file per finding
```

`audit.md` frontmatter is `layout_version`, `date`, `title`, `scope`. `layout_version` is an
integer, bumped only when this contract changes such that existing files no longer satisfy
it. `date` is `YYYY-MM-DD`, like every stamp a finding carries. No program writes
`audit.md` — the docket parses it and never rewrites it, so it is the one file under this
directory that changes by hand, and the one whose format violations are fatal rather than
flagged: a header the parser rejects leaves the whole directory unreadable.

Retiring a field changes the parser first and migrates the corpus second: the parser absorbs a
key it no longer knows, but a key it still requires and a finding no longer carries fails every
file at once.

The contract is stated once, here. Never copy it into an audit directory: two files
stating the same rules is the duplication `docs/CODE-RULES.md` bans, and `layout_version`
already carries the versioning.

## Frontmatter fields

Keys are emitted in exactly this order. A write that changes nothing is therefore
byte-identical to what it replaced.

| Field               | Type           | Values                                       | Default       | Written by                                      |
| ------------------- | -------------- | -------------------------------------------- | ------------- | ----------------------------------------------- |
| `id`                | string         | the sanitized filename stem                  | required      | audit agent                                     |
| `title`             | string         | one sentence naming the concrete problem     | required      | audit agent                                     |
| `severity`          | enum           | `critical` `high` `medium` `low`             | required      | audit agent; human corrects                     |
| `kind`              | enum           | `defect` `decision`                          | required      | audit agent                                     |
| `status`            | enum           | `live` `latent` `unclear`                    | required      | audit agent; human corrects                     |
| `status_note`       | string \| null | free text qualifying `status`                | `null`        | audit agent                                     |
| `area`              | string         | repo-relative area, e.g. `apps/api`          | required      | audit agent; human corrects                     |
| `needs_ruling`      | boolean        |                                              | required      | audit agent, at emission only                   |
| `needs_options`     | boolean        |                                              | `false`       | audit agent; human, via reopen                  |
| `warning`           | boolean        |                                              | `false`       | audit agent                                     |
| `related`           | string[]       | finding ids                                  | `[]`          | audit agent                                     |
| `group`             | string \| null | group name                                   | `null`        | audit agent                                     |
| `dedicated`         | boolean        |                                              | `false`       | audit agent; human; implementation agent        |
| `state`             | enum           | `open` `ruled` `denied`                      | `open`        | human; audit agent sets it at emission          |
| `ruling`            | map \| null    | see below                                    | `null`        | human; audit agent sets it at emission          |
| `denial`            | map \| null    | see below                                    | `null`        | human; audit agent writes `by: "audit"`         |
| `history`           | map[]          | see below                                    | `[]`          | human; audit agent may ship entries at emission |
| `questions`         | map[]          | see below                                    | `[]`          | human asks; implementation agent answers        |
| `progress`          | map            | the four keys below                          |               | per key, below                                  |
| `progress.status`   | enum           | `not-started` `in-progress` `blocked` `done` | `not-started` | implementation agent; human                     |
| `progress.updated`  | string \| null | `YYYY-MM-DD`                                 | `null`        | implementation agent                            |
| `progress.verified` | boolean        |                                              | `false`       | **human only**                                  |
| `progress.notes`    | map[]          | see below                                    | `[]`          | implementation agent, human                     |

Compound shapes:

```
ruling           { option, text|null, note|null, at }
denial           { by, reason|null, at }
history[]        { at, kind: "ruling"|"denial", superseded_at,
                   option?, text?, note?, reason?, by? }
questions[]      { at, text, answer|null, answered_at|null }
progress.notes[] { at, by: "human"|"agent", text }
```

Every moment the format holds is a day: `at` wherever it appears, `superseded_at`,
`answered_at` and `progress.updated` are `YYYY-MM-DD`, and a value carrying a time is
refused on write. The rule reads the typed fields and never the frontmatter text — a note's
`text` is prose and may quote an instant, and scanning it for one would make that finding
unwritable.

`denial.by` is `human` or `audit`. Questions run one way: the human asks, and an
implementation agent answers. An answer is not the human's to write. `progress.status`
runs both ways: the agent reports where it got to, and the human moves it on — to any
status the field admits, so a human can park a finding as well as return one to the
queue — and recording a human's move as the agent's would misname who decided. A
finding the human parks as `blocked` is a deliberate setting-aside, not an agent
stopped and waiting on an answer, and the note the mandate forces — who parked it,
and why — is what keeps the two readable apart. Answering a block is the narrower
act with a name of its own: both surfaces do it through `unblock`, which will not
fire without the answer that unblocks.

`dedicated` marks a finding whose fix is too large for one task, or which needs a deep
design session before code is written; either limb alone qualifies. It is a disposition,
not progress: it says who takes the work, never how far along it is, so it changes
neither `state` nor the ruling, and an open finding may carry it. A dedicated finding
leaves the queues ordinary work is picked up from — `open` and `ruled` — and is read from
the Dedicated queue instead; the surfaces that exist for attention or observation keep it,
so a dedicated finding still appears in `blocked`, `questions`, `progress` and `denied`. The
audit
agent may set it at emission; afterwards a human sets it either way, and an
implementation agent marks a finding it judges too large without asking — and clears
only a mark it set itself, once the work turns out to fit; clearing a human's mark is
the human's decision.

Two limbs decide it, and either alone is enough: the fix is **too large** for one task, or it
**needs a deep design session** before code is written. Largeness is the heading, not a
checklist — crossing subsystems, rewiring a shared contract, or a call-site sweep no
reviewable diff absorbs are the shapes it usually takes, and none of them is sufficient on
its own, so a one-line schema change is not dedicated. Set it when the case is clear and
leave it otherwise: a missed mark is caught cheaply the next time the work is picked
up, and a wrong one is cleared by whoever set it.

**The field and the option marker answer different questions.** Set the field when the
finding is dedicated whichever option is chosen. When it turns on _which_ option is chosen —
one answer is a redesign and its siblings are an afternoon — the marker belongs on that
option instead, and only a human can write it, because no agent writes a body.

`history` is one chronological array rather than one array per kind. A superseded ruling
and a cleared denial are both what the finding used to be, the console renders them as a
single list, and a second array would exist only to keep them apart.

## YAML subset

Hand-written emitter and parser, no YAML dependency. Everything outside this subset is a
format violation, not a style preference.

- Fixed top-level key order, as tabled above.
- Scalars are `null`, `true`, `false`, integers, and strings. **Strings are always
  double-quoted with JSON escaping**, including enum values, which removes every
  block-scalar and multi-line edge case.
- Arrays are `[]` when empty, otherwise a block sequence of scalars or of inline flow maps
  of scalars.
- Maps go at most two levels deep. No anchors, aliases, tags, comments, or
  multi-document markers. A YAML comment cannot be used to annotate a field.

## Structural invariants, checked on every parse

- `ruling` non-null ⟺ `state: "ruled"`. `denial` non-null ⟺ `state: "denied"`.
- Option ids are unique and match `[A-Za-z0-9_-]+`.
- `id` equals the filename stem.
- `id` is already its own sanitized form (`unsanitized-id`): every character outside
  `[A-Za-z0-9._-]` becomes `-` and runs collapse. Matching the stem does not imply it — a
  file whose name carries a space has an `id` equal to its stem and is still refused, and
  every later write to that finding is refused `invalid`.
- Every enum field holds one of its listed values.
- `progress.status: "blocked"` requires `state: "ruled"` (`blocked-without-ruling`). A block
  is raised against a ruling and cannot outlive it: every decision resets the status, so
  work blocked on a decision nobody made is unwritable rather than merely unlikely.
- Every timestamp field is a day (`non-day-timestamp`), the typed fields only — a note's
  prose is not a field and is not checked.

Every parse checks exactly this set, and a write that would break one is refused.

## Emission rules, checked only when an audit is created

Read the three in order; the first that applies is the only one that does.

- A finding the audit ships `state: "denied"` carries zero options and
  `needs_options: true`, and the two rules below do not reach it. The audit refuted it, so
  it was never analysed for options; resurrecting one routes it to option minting, which is
  what `needs_options: true` is for.
- Otherwise, `needs_ruling: false` ⟹ exactly one option, and the finding ships
  `state: "ruled"`.
- Otherwise, `needs_ruling: true` ⟹ at least one option, with at most one marked
  `**Recommended**`. Zero options is legal only when the audit has no proposal at all, and
  `needs_options: true` then says so.

**The proposal is an option, never a body paragraph.** A finding whose audit has one
proposal ships one option carrying it. An open finding with no option cannot be approved as
proposed: the only approve path left is a typed ruling, and `ruling.text` outranks the
body, so a proposal parked in the explainer is a proposal a retyped sentence replaces.

These rules, including the proposal rule above, bind the audit agent writing a fresh audit,
and they are never rechecked afterwards. **A live finding that violates them is not a
defect and must not be "fixed".** A human can reopen a finding that shipped
`needs_ruling: false`, which leaves it `open` carrying a single option permanently, and a
finding emitted under an earlier version of these rules keeps the shape it shipped with.
`needs_ruling` records the audit's judgement at the moment of emission and never changes.

## Body, options, filename

The body is everything after the closing `---`. Everything in it before the last
`## Options` heading is the explainer.

The explainer states the problem and its evidence: what the thing is, what it does now, why
it needs a ruling. What to do instead is not in the explainer — that is the option.
Acceptance criteria go in the explainer when they hold whichever option is chosen, and in an
option's own prose when they differ between options. Never both: a criterion stated in two
places is a copy that can drift, which is what `docs/CODE-RULES.md` bans.

Each option is `### <id> — <label>`, then an optional meta line, then prose.
`**Recommended**` appearing in the option's first non-blank content line marks it as
recommended, so a blank line between the heading and the meta line changes nothing.
`**Dedicated**` on that same line marks an option whose being chosen makes the finding
dedicated; the marker informs the ruling screen and moves nothing on its own, because
only the field does. A body with no `## Options` heading has no options.

Per-option criteria go in the prose, after the meta line: a first content line that stands
alone is read as the meta line whatever it says.

The filename stem is `id` with every character outside `[A-Za-z0-9._-]` replaced by `-`
and runs of `-` collapsed. `id` is that sanitized form, so the stem and `id` always match.

## Two rules that hold everywhere

**No program writes the body on its own.** Every writer rewrites frontmatter only; the body
bytes from the closing `---` onward are preserved exactly. The body is the evidence and the
reasoning the human is ruling on, so a tool able to rewrite it could silently change what
was agreed to. The gate is the human, not the format: a human may authorize one body
rewrite — a migration whose exact change was approved first, moving text verbatim rather
than retyping it, so what was agreed to survives byte for byte. A human may also authorize an
**annotation**: a `**Since this audit was written.**` paragraph recording a verified fact about
the world the finding describes — a cited file deleted, a claim already remediated. It is newly
written prose rather than moved text, it states the fact and stops, and it never rules, denies,
or implies a disposition; the convention is to close it by naming the ruling as the human's.
Nothing else writes a body: no agent by hand, no CLI command, no console action.

**Writes do not interfere.** Every field names its writers, which is what the field table's
**Written by** column is, and a write naming a field its writer does not own is refused.
Every write also re-reads the file inside the lock immediately before applying, so what
lands touches only the caller's fields. That is what lets the human rule on a finding in the
same second an implementation agent appends a progress note, with neither losing the other's
write.

The column names who decided, not whose hands typed. A decision the human takes
outside the console reaches the file through the CLI's mandated actions — every
action that carries a human decision takes a mandate, and `--help` marks each —
written as the human because the human is who decided, with the mandate carrying the
human's own words and the note recording that an agent relayed them.

A field with two writers is where that guarantee does its work, not a hole in it:
non-interference holds per field, and each field with two writers has its own reason it
holds. `progress.notes` is a list a write adds to rather than replaces, and what it adds is
computed from the file as re-read inside the lock, so two writers cannot lose each other's
entry. `progress.status` is a scalar, with nothing to add to: what keeps its two writers
from losing each other is that a write replacing it names the version it was decided on.
Which of them writes when is ordered by intent — the agent reports where it got to, the
human moves it on.

Ownership says who may write a field. What stops two writers who both may from losing each
other's work on it is that a write may name the version of the file it was decided on: the
store then hashes only the fields that write turns out to touch and refuses it unless they
are exactly as that version had them. A refusal writes nothing, and the answer to one is to
read the finding again rather than to send the same write a second time.

Which writes name a version follows from their shape. A write that **replaces** a value
carries one, because a replacement is the kind that can lose work with nothing raised:
`progress.status` has nothing to merge, so an agent's `blocked` would otherwise be cleared by
a human acting on a screen taken before it. A write that **adds** an entry does not need one:
what it adds is computed from the re-read file, so two additions cannot lose each other, and
answering a question that already holds an answer is refused whatever version the write names.

`unblock` is the third shape: it replaces `progress.status` and appends to `progress.notes`
in one write, and it names a version for both. What fences the note is not the collision the
addition rule covers — the answer is one human's single act, so there is no second writer
adding a different entry — but a screen drawn before a further note landed, on which the
answer given answers a different question than the one now on the finding.

A mandated relay adds no shape of its own: it takes whichever of these its write
already has, and is fenced accordingly. A decision whose own field carries words — a
ruling's note, a denial's reason — carries the mandate there, and the write stays the
pure replacement it was. A decision without such a field carries the mandate as a
progress note beside its replacement, which is `unblock`'s own shape, fenced over
both. And a relay whose write only appends — a question, a note that is itself the
whole of what is said — lands as any standalone addition does, and is unfenced for
the same reason a standalone addition is.

Undo is the widest replacement there is, and the version it names is as wide. It puts a
finding's whole frontmatter back as an earlier write left it, so anything that moved since is
exactly what the restore would discard — which is why it is refused if the finding changed at
all since that write, not only in the fields that write touched. That is the same rule as
above applied to a write whose fields are all of them, not an exception to it. The refusal is
final: after a reload the restore would still discard what moved, so the undo is not offered
a second time.

An addition that stands alone must not name a version, not merely need not. A finding's notes
and its answers are each hashed as one value, so a version named on one refuses two writers
who added _different_ entries — two agents answering different questions of the same finding,
most of all. `unblock` is the one exception, and it names its version for the replacement it
carries rather than for the note. The console and the CLI both follow this rule, so it holds
however a write reaches the file.

## The three kinds of writing, and there is no fourth

- A **question** requests information. It is asked because the answer is not known.
- An **option note** directs how a ruling is carried out. It rides on the ruling and
  outranks the chosen option's prose.
- A **progress note** records what happened. It is history, never instruction — with the
  exception the axis of the taxonomy explains. What separates the kinds is whether the
  writing changes the ruling: an option note directs how a ruling is carried out, a progress
  note does not touch it. The human's words — the answer to a block, the mandate a relayed
  decision carries — are actionable and still change no ruling, so they ride the history
  channel, and there is no fourth kind.

If what you are about to write is none of these, it does not belong in the file. These are the
frontmatter kinds; the body's one authorized addition is the annotation above.

## State machine

Findings ship `open`, except those the audit judged obvious, which ship `ruled`, and those
it refuted, duplicated, or put out of scope, which ship `denied` with `by: "audit"`. One it
could not settle by reading code is not a shape of its own: it ships `open` with the
uncertainty stated in its body, under whichever option shape the emission rules above admit.

| From              | Action                          | To        |
| ----------------- | ------------------------------- | --------- |
| `open` `denied`   | rule                            | `ruled`   |
| `ruled`           | rule again, changing the ruling | `ruled`   |
| `open` `ruled`    | deny                            | `denied`  |
| `ruled` `denied`  | reopen                          | `open`    |
| `ruled` + blocked | unblock                         | unchanged |
| any               | ask, answer, withdraw           | unchanged |
| any               | progress                        | unchanged |
| any               | dedicate                        | unchanged |

- **Changing a ruling keeps every progress note.** The outgoing ruling is pushed onto
  `history` with `kind: "ruling"` and its `superseded_at`, and the notes are what survives.
  The status and the verification do not: every decision returns `progress.status` to
  `not-started` and `progress.verified` to `false`, because work standing at `blocked` or
  `done` against a ruling that no longer exists is a claim about a decision nobody made.
  `progress.updated` survives, being the agent's stamp that a human-attributed write may not
  name. The reset is written only where there is something to reset.
- Any action that clears a decision archives it the same way: reopen, denying a ruled
  finding, and ruling a denied one all push the outgoing ruling or denial onto `history`.
  Nothing that was decided is dropped without a record. The verification is the one thing
  that goes without one: the same clearing drops `progress.verified`, and no `history` entry
  says a human had ever set it, so a re-decided finding reads unverified with nothing on
  record that it once was.
- Reopening a finding that has no options sets `needs_options: true`.
- **Unblocking is the human answering the block.** It appends the answer as a `by: "human"`
  progress note and returns `progress.status` to `not-started` in one write, leaving `state`
  and the ruling standing — the block was raised against the ruling rather than about it. A
  non-empty note is required, because unblocking on silence hands the finding back with the
  question that stopped it unanswered. On a finding that is not both ruled and blocked it is
  refused `invalid-transition`.
- **A finding appears in Questions whenever it holds more questions than answers.** That
  membership is derived on every read and never stored, so no flag can come to disagree
  with the array it describes.
- **Questioning is reachable from any state**, ruled and denied included. A decided finding
  carrying an outstanding question appears in Questions and keeps its place in Ruled or
  Denied: the decision stands, and the question about it is a separate fact.
- `progress` never changes `state`.
- `undo` reverts the last write for one finding.

## Working a finding as an implementation agent

Your finding is `docs/audits/<date>/findings/<ID>.md`, and the id is in your brief. You read
it through the CLI, never by opening the file — the brief it prints for the ids you name is
the finding as an implementer needs it.

**`pnpm docket --help` is the statement of the CLI** — every action, the flags each one
takes, the values those flags accept, and what separates a queue from the state it is named
after. Read it there rather than anywhere else, this page included.

Take work from the ruled queue, take stock from the progress queue, and read what is stuck
from the blocked queue.

Check a finding's citations before you trust them. The audit is dated and the tree is not, so
a file a finding cites may have moved or gone since, and the census is what answers which
ones still resolve.

Read `ruling` before the body. **`ruling.text` outranks the chosen option's prose.** The
option is the proposal that was chosen from; the ruling text is what was actually decided.
Where they conflict, the ruling text wins. `ruling.note` directs how to carry it out.

Report through the CLI, never by editing a finding file: record that you have started before
you begin, leave a note saying what happened, and record the terminal status when you stop.
A question the human left on the finding is answered the same way.

Hand-editing writes fields you do not own and can break the format silently; the CLI
physically cannot produce a file the console will not read, and it writes as the
implementation agent everywhere but under a mandate, where it records the human's
decision as the human's.

`progress.status: "done"` is **your claim that you did the work**. `verified` is the
human's separate statement that the behavior is right. You never form that verdict:
`verified` moves only under a mandate quoting the human's explicit words, and the CLI
refuses every other attempt.

If you are blocked, set your progress status to `blocked` and leave a note saying what blocks
you. The `blocked` status is writable only on a ruled finding — a block is raised against a
ruling, so there has to be one — and refused on any other. A blocked finding leaves the work queue and
waits for the human, with the whole run of notes you left since the last human word, and
every reply since, beside the ruling controls — the reason and the action that answers it on
one screen — so no later implementer is handed a ruling that is under contest. If a ruling is
wrong or unimplementable, say so in a note and stop rather than reinterpreting it.

A finding too large for the task holding it is not a block: mark it dedicated through
the CLI, leave a note carrying the evidence, return your status to `not-started`, and
carry on with the rest of your task. Nobody is waiting on the human, so nothing is
blocked. Undo only a mark you set yourself, once the work turns out to fit; a human's
mark comes off only as their own relayed decision.

An answered block comes back as an ordinary ruled finding: the answer is appended as a human
progress note and the status returns to `not-started`, the ruling standing. Its brief prints
the whole note thread in recorded order, each note labelled by its role (`Note` or
`Reply`), so the reason the work stopped, the answer to it, and every exchange before
them arrive together.

A human may answer a block outside the console. Relay the answer through `unblock`
with a mandate quoting it verbatim and naming where it was given: the write lands as
the human, because the human is who decided, and the note records that an agent
relayed it. Never write the answer as your own note and move the status yourself —
that records the human's decision as your report. An unblock is only ever a human's
answer: with no human word to relay, a block you can clear yourself is cleared by
returning your own status through the agent's ordinary write, never through
`unblock`, whose note would claim an answer nobody gave.

## Lifecycle

An audit directory is live until every approved finding in it is closed, and afterwards it
is the dated record of what was decided and why. It is never a description of the current
system, so it never goes stale and is never rewritten to match the code as the code moves.

The general documentation lifecycle rule in `docs/CODE-RULES.md` — every doc is loaded,
on-demand, or history — does not apply to these directories and is not licence to delete a
finished audit.
