---
name: create-film
description: Make a HushBox film — an ad whose every frame and sound is rendered from code in `films/` — by giving Claude full creative freedom, then the founder's feedback on moving clips, then full freedom again. Use when the user wants to make, re-stage, or iterate on a film, a motion-design piece, or a code-rendered ad. Trigger on "make a film", "new film", "create a film", "motion design", "animated ad", "films/". An ad built from AI media, captures and voiceover in `ads/` is create-ad.
argument-hint: The film's idea, and any reference clip, file or instruction
---

# Create a film

$ARGUMENTS

You are the film's director, in every round and through the port. Everything is yours to choose and open to change in every round (the story beats, the words, the music, the staging, the look), except what the founder instructs explicitly. The founder judges moving clips. The engine in `films/` is the host a film passes through: the timebase, audio synthesis and mastering, the look host, rendering, delivery, the checks and the brand. `craft.md` beside this file holds briefs that worked and the craft bar; the `film-reviewer` agent carries the rubric.

## What every take keeps

- **Explicit instructions.** An instruction the founder gives, in the brief or in any verdict, binds every later round until the founder lifts it. Everything else is open.
- **Claims.** Every claim HushBox makes about itself is a checkable fact scoped to its exact boundary, checked against the code, with its source: "we can't read your stored conversations" names what is stored. A statement about AI companies in general is opinion. Every on-screen line declares its basis: a fact with its source, opinion, or a brand line.
- **The beat.** A take's score sets its beat grid, and its shots are staged on that grid. Every cut, arrival and hit lands on a beat or half beat; every visible hit has its sound on the same frame, and every sound its visible action.
- **Muted.** Every point lands as on-screen text inside the safe box, at or above the size floor for its role, held at least its reading time, and within the text-contrast and flash (WCAG 2.3.1) checks. `pnpm films verify` applies them at the port (`films/engine/layout/`, `films/engine/film/spec.ts`).
- **The open and the close.** Frame 0 is composed, readable and moving, with sound inside the first 0.1 s. The close is the brand's: warm charcoal, Signal Red, the brand type and the tagline "One interface. Every feature. Private." Signal Red marks HushBox and nothing else. Brand colours and faces reach the look through its `ctx`.
- **Code only.** Every frame and every sound is rendered from code. A film reads the repo's brand fonts and logo, and open-licence fonts under `films/fonts/<family>/`, each family beside its licence file. To use a package, propose it to the founder, and add it to `films/package.json` once approved.
- **Pure in the frame.** A take's look is a module, `look.ts` or `look.js`, exporting `renderFrame(frame, ctx)`; inside it the form is yours, on the 2D or WebGL2 canvas the host gives. It draws frame `frame` from the frame number alone, takes every random value from the seeded source in `ctx`, and draws the same pixels for a frame however often and in whatever order it is asked. It returns the text it drew as boxes, and leaves the text out when `ctx.hideText` is set, so the checks can measure the text against its background. A look opts into the host's sub-frame motion blur and post chain in its export. The contract is `films/engine/look/`.

## Where a film's work lives

Round work is the film's own record, kept in its directory `films/<YYYY-MM-slug>/`:

- `brief.md`: the brief, then every explicit instruction as it arrives, verbatim, under its `YYYY-MM-DD` date.
- `rounds/<NN>/<take>/`: one directory per take. `NN` is the round, two digits from `01`; `<take>` is a kebab-case name for the take's genre or idea. Take code here is exploration and sits outside the package's code gates. The directory holds:
  - the look module, and `score.ts` with the take's grid, cues and music;
  - `shots.md`, the take's shot table;
  - `review.md`, each `film-reviewer` return appended;
  - `verdict.md`, the founder's words on the take, verbatim, under their date;
  - `out/`, written by `pnpm films take` and ignored by git through the root `.gitignore`'s `out/` rule, because it rebuilds from the look and the score.
- `rounds/approved.md`: the path of the approved take, which the port reads.

## Before the first round

Agree the brief with the founder in one message and write it to `brief.md`:

- the idea, as one transformation from A to B, shown happening rather than asserted over a mood;
- any reference the founder gives: a clip, a file, a named piece;
- every explicit instruction: lines, beats, music, anything the founder fixes;
- the length. A film of up to 30 s is one piece. A longer film is several pieces of 15 to 30 s, each taken through the rounds, and the first approved piece sets the bar for the rest.

## A round

Round 1 makes three takes that differ in kind, each built on a different genre or reference ("motion-design showreel", "music video", "Apple-keynote launch film"). When the brief names a reference, it is one of the three. A named genre or reference selects the motion vocabulary; without one the model draws its default look. Dispatch one general-purpose subagent per take, in parallel. Give each `brief.md`, its genre or reference, this file, `craft.md` and its take directory; each builder runs steps 1 to 3 and hands back its take. Every later round makes one take, which you build yourself. A later round starts from `brief.md` and every verdict so far.

1. **Stage, from full freedom.** Choose the take's story beats, words and music within the brief's instructions, and set its beat grid. Then write `shots.md`: one row per shot on the grid, giving frames, framing, camera move, the composition event (what becomes what), the reads in order, the transition, the text, and the cue it lands on. Stage a new composition every one to two seconds, with shots that morph into one another (`craft.md` §The craft bar). In a later round the whole film is open again. Keep something from an earlier round only when you would choose it fresh against the new feedback, and say in `shots.md` what you kept and why.
2. **Score and build.** Write the take's `score.ts` on the engine's audio modules and `films/engine/dmath/`, as a film's score is written, so it ports unchanged. Write its look module, drawing every element for this take: its fire, figures, type and transitions are made here.
3. **Render and look.** Run `pnpm films take <take-path>`, where the path is the take directory's path under `films/`. It renders the score and the look and writes into the take's `out/`: `take.mp4`, `master.wav`, a still on every beat, a contact sheet at one frame per 0.25 s, a strip around each cue labelled with it, and `composition.json`. It runs no gate. Look before anyone else does: read the stills, the sheet, the strips and the report. Cut a close crop of every face and small detail that carries the story from the stills into `out/crops/`, using `sharp`, a films dependency. Recut them after every render: the take verb rewrites its stills and strips and leaves `crops/` as it was. Fix what is off the grid, frozen, cramped or unreadable, and render again until you would show it.
4. **Review.** For each take, dispatch the `film-reviewer` agent with the take's `out/` path and nothing else. Append its return to the take's `review.md`. Act on the notes you agree with (in round 1, hand them back to the take's builder); `STAGING: FAILS` sends the take back to step 1. After at most three reviews, the founder sees the take whether or not it passes.
5. **The founder watches.** Publish every take of the round on one artifact page where the `take.mp4` files play, each with one sentence on what it tries, and ask for the verdict. Write the founder's words to each take's `verdict.md`, verbatim; a message about several takes is copied whole into each. An explicit instruction in a verdict is also added to `brief.md`. The founder judges motion; stills are for your own looking.

A round with no approved take starts the next at step 1 with the whole film open: feedback reshapes the target, and the new take is a fresh staging, not polish of the last one. After two rounds with no approved take, ask the founder for a reference clip and the words that would change the verdict before the third.

## After the founder approves

Write the approved take's path to `rounds/approved.md`, then port the take yourself, inside this skill:

- The take's look module and `score.ts` become the film's `look.ts` and `score.ts`. Its `shots.md` becomes the spec's shot table, and its words become the spec's text rows, each with its basis.
- The film's `film.ts` carries the package's unit coverage. Its `look.ts` and `score.ts` sit inside typecheck and lint and outside unit coverage, proven by the checks.
- `pnpm films verify <film>` passes every gate. Every beat's still of the ported film matches the approved take's still of the same frame byte for byte, and the film's `master.wav` matches the take's byte for byte. When a frame or the master differs, list it with its reason; the founder watches the ported MP4 before the port stands.
- `pnpm films render <film>` writes the delivered MP4. The founder listens on phone speakers and headphones before the film is called done.

If the film has another piece, that piece's first round follows, starting from the delivered film.
