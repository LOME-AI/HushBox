# Film craft

Reference for the `create-film` skill: briefs that worked, the craft bar a take stages to, and the composition report. Provenance: the dated research record under `docs/runs/2026-09-26-films-from-code/research/` (`viral-methods.md`, `founder-reference.md`, `why-we-struggle.md`, `reference-animations.md`, `motion-guides-2026-09-29.md`), gathered 2026-09-28 and 2026-09-29.

## Briefs that worked

The most-reached code-made motion pieces of 2026-09 came from short briefs that name a genre, often with a reference; the model supplied the grammar. Quoted verbatim:

- The showreel prompt, run one-shot by three creators to about 4.35 million views between them: "make a dynamic 15-second motion graphics video that shows what an incredible motion designer you are, like it's your showreel for a résumé. go all out."
- A book trailer, one prompt with the book attached: "Create a dynamic 30-second motion trailer, like a motion designer's showreel, explaining this book." The model mapped nine scenes to "128 BPM (16 bars = 30 seconds)".
- A single-file film: "Make an 80 second square animated film as a single HTML file, using WebGL2 and plain JavaScript, with no libraries and no image, font or audio files. It should look like a glass and gold leaf wall mosaic whose tiles were never glued down, so they can lift, flip, fly and click back into place. Figures are flocks of tiles, so a fish swims by its tiles swimming".
- A launch-film template: "An Apple-keynote launch film, 2D only, one continuous take. Every scene is made out of the previous one: nothing fades, blurs or cuts." "120 BPM, 54 beats, something happens on every beat." "Springs are closed-form step responses. A value with many targets is the sum of one spring per change".
- A UI-morph template: "Render one frame per beat before the full render. Fix anything off the grid, cramped or hard to read."
- A reference reproduction: "绝对不要做成互相割裂的幻灯片切换。每一个场景都必须自然地在视觉上形变过渡至下一个场景。" (Never a slideshow of disconnected slides; every scene must morph visually into the next.)
- A diorama: "画面のどこかで常に何かが動いている" (something is always moving somewhere on screen), and "できたら各視点のスクショを撮って、自分で見て直してから見せて" (when done, screenshot each view, check it yourself, fix it, then show me).

One creator's summary of a brief with no genre or reference: "without a reference, opus falls back to its default look: centered text, gradient background, everything fading in".

## The craft bar

- **The picture becomes a new picture.** Motion-design pieces and music videos with reach change their whole composition 5 to 8 times per 10 s, while only a small share of the frame moves at any instant. Three routes get there: a cut on the beat; one element morphing into its next state; a world transforming in place, or a camera flight across scale (20 to 40 times, zoomed exponentially) that hands one world to the next at a tinted flash.
- **Every shot ends somewhere it did not begin.** Flicker, bob and drift return the same picture; a galaxy condensing from debris or a figure assembling from light leaves a new one.
- **One read at a time.** A read is one thing the viewer must understand. List each shot's reads in order in `shots.md`, and time each for the viewer to find it and take it in: "Don't start a new read while the viewer is still taking in the last one." Actions can be fast when they are anticipated; "what it means needs held time."
- **Five layers keep everything alive**, each closed-form in the frame:
  - a camera that moves every frame, with zoom interpolated in log space;
  - per-element idle motion keyed to the beat, or to incommensurate sines with a seeded phase per part, so parts breathe apart;
  - impact envelopes summed from the cue list, driving shake, zoom, flash and squash;
  - springs on every arrival, with anticipation and an overshoot that settles, their stiffness set by role: snappy for UI (buttons, toggles, leading edges); default for cards, containers and camera; heavy for big type, 3D objects and logo lockups; playful, overshooting visibly, for mascots and stickers;
  - a textured surface that re-rolls a few times a second: line or brushstroke boil indexed by `floor(t · rate)`, seeded per element.
- **Figures are built from elements**: flame tongues on a rig, flocks of tiles, particles morphing between targets, over a hidden closed-form skeleton. A fixed shape reads as alive when every parameter of it moves on the beat.
- **Character animation's principles hold in code, twinning first.** "Code copies values, so both arms end up at the same angle, both eyes blink together and a crowd bounces in unison… Give one arm the action and the other something smaller." Beyond that: motion travels on arcs, trailing parts follow through and overlap, impacts squash and stretch, and every action passes through a strong key pose.
- **Light and colour travel.** Luma and hue move across the piece, and flashes to white or a tint seal transitions; one grade held throughout reads as one scene. Aim for a luma range (p5 to p95) of at least 0.3 and a hue spread of at least 30°: the founder's reference clears both, and the rejected openings missed both by far.
- **Hook, then pay off.** A hook lands within the first 2 s and a visual payoff every 3 to 5 s ("a visual payoff every 3 to 5 seconds, a hook in the first 2"). Build into each payoff: intervals shorten, intensity rises, and the frame inhales to dark before the drop.
- **Shot length follows form.** Hype and comedy run 1 to 3 s a shot (12 to 20 shots in 30 s); story runs 2 to 5 s.
- **Simulations are closed-form.** Express each ripple, flock member or fluid element as a function of the frame and its seed, so any frame draws alone.
- **A frame costs at most 2 s of compute to draw.** Cost follows what is drawn, not the resolution: "hundreds are fine, thousands are not" for filled shapes and strokes. A take's render time divided by its frame count bounds the cost from above.

## The composition report

`pnpm films take` writes two numbers to the take's `out/composition.json`: composition turnover, and travel (the net change over 2 s divided by all the motion between). They report and fail nothing; the founder's verdict decides, and `film-reviewer` reads them against the references. Travel is the number that tracks "one scene of mostly static items": a frame busy at every instant, with parts that move and return, still reads as one scene.
