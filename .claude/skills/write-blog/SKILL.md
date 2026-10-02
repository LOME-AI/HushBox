---
name: write-blog
description: Write a blog post for the HushBox marketing site (hushbox.ai/blog). Use this skill whenever the user wants to create, draft, plan, or iterate on a blog post. Trigger on mentions of "blog", "blog post", "write a post", "new article", "content for the blog", or any reference to hushbox.ai/blog content creation. This skill handles the full lifecycle — topic research, outline, drafting, anti-slop review, and final MDX file output. It does NOT handle the Astro engineering setup (content collection config, page templates, RSS feed) — only the content creation workflow.
argument-hint: Topic and author — e.g. "Why your AI conversations should be encrypted — author: Sarah Chen"
---

<!-- AUTO-GENERATED from .claude/skills/write-blog/SKILL.template.md and the shared sources it draws on. Do not edit directly; edit those sources, then run pnpm generate:skills. -->

# Write Blog Post for HushBox

This skill produces a single MDX blog post file ready to drop into `apps/marketing/src/content/blog/`. One file, one post, zero engineering friction.

## Input

This skill takes one argument from the user:

**`topic_and_author`** — A short description of what the blog post is about and who the author is. Example: `"Why your AI conversations should be encrypted — author: Alex Chen"` or `"GPT-4o vs Claude Sonnet vs Gemini comparison — author: HushBox Team"`.

If the user doesn't provide an author, default to `"HushBox Team"`.

---

## Workflow

### Step 1: Research & Plan

Before writing a single sentence:

1. **Search the web** for the topic. Find current data, recent news, competitor claims, pricing pages, documentation — anything the post will reference. Gather specific numbers, dates, quotes, and facts. Every factual claim in the final post must trace back to a verified source.
2. **Search the codebase** if the topic involves HushBox features (OPAQUE, encryption, architecture, pricing). Read the actual source code in `apps/` and `packages/`. Do not describe features from memory — verify them against the code. The code is the only source of truth for what HushBox does.
3. **Discover existing tags.** Read all `.mdx` files in `apps/marketing/src/content/blog/` and extract the `tags` arrays from their frontmatter. Collect the full set of tags currently in use across all published posts.
4. **Present a plan to the user** that includes:
   - The angle / thesis (one sentence: what should the reader believe after reading this?)
   - 3–5 section headings (rough, not final)
   - Key facts and data points you found, with sources
   - The voice for each section (see Voice section below)
   - Estimated word count (target: 1,200–2,000 words)
   - **Proposed tags**, marking each as `(existing)` if it's already used by another post, or `(new)` if this would be its first use. This keeps the tag namespace intentional without a rigid taxonomy.
   - **Proposed visuals**, each with the one sentence of prose it replaces (see Visuals below). Propose none when no section has a fact a picture shows better than a sentence.

### Step 2: Iterate with the User

Ask the user pointed questions before drafting. Examples:

- "I found [competitor] claims [X] on their pricing page. Do you want to address this directly or leave it implicit?"
- "The OPAQUE implementation in `packages/crypto/` uses [specific detail]. Should we go this deep or keep it conceptual?"
- "This topic could go technical-explainer (Feynman voice) or moral-argument (Hitchens voice). Which feels right?"
- "I found three conflicting stats about [topic]. Here they are — which source do you trust?"

Do NOT proceed to drafting until the user confirms the plan.

### Step 3: Draft

Before the first sentence, write a claim ledger to the scratchpad: every claim the post will make about HushBox, each with the file path and symbol that supports it (a route class, a schema column, a function), and every third-party claim with the source it rests on. Establish every "cannot" about HushBox by reading the routes and schema it depends on; a doc states intent, and the code is the claim's evidence. The ledger is your own tool: it stays in the scratchpad, and the fact checker builds its own without seeing yours.

Then write the full post as an MDX file. Follow every rule in the Output Format, Quotations, Visuals, Voice, and Anti-Slop sections below. After drafting:

1. Run the complete Anti-Slop Checklist (see below) against your own draft
2. Flag any violations and fix them before the adversarial pass
3. Write the draft to `apps/marketing/src/content/blog/` with `draft: true` in its frontmatter, so the adversaries read the file the reader will

### Step 4: Adversarial Pass

Two read-only agents attack the first draft. Dispatch both in parallel, in one message, each with the draft's repo-relative path. Neither receives the plan, the research notes, the claim ledger, or a summary of what the post argues; they judge blind on purpose. The slop hunter's dispatch line carries one thing more: the plan's per-section voice (each section heading and the voice it is written in).

- `blog-fact-checker` opens every cited source, checks every HushBox claim against the code, writes the strongest rebuttal a hostile expert would post, and names the weakest sentence. It runs again after the fixes.
- `blog-slop-hunter` applies the anti-slop checklist as a hostile reader, judges each section against its named voice, and names the paragraph that reads as machine-written. It runs once per draft.

Each returns a verdict, a BLOCKING list, and a SHOULD_FIX list; the slop hunter also returns a KEEP list. Then:

1. **Stop on thesis drift.** When a BLOCKING fact-check finding changes what the post can claim about HushBox or the subject, stop before editing the body. Restate the thesis and the title as the evidence now supports them, and return to Step 2 for the user's ruling. Drafting resumes on a re-confirmed plan.
2. **Reconcile the claim ledgers.** Compare your claim ledger against the fact checker's CLAIM_LEDGER. A claim the checker did not verify is unverified until you verify it yourself, by running the code, reading it, or fetching the source; record the verification in your ledger.
3. **Resolve every BLOCKING finding** in the draft. An unsupported claim gets a source or gets cut; a HushBox feature the code does not ship gets rewritten as design or cut; a banned word gets replaced.
4. **Rule on each SHOULD_FIX finding.** A slop-hunter SHOULD_FIX is advisory, and agreeing with it is a judgement, never the default. For each, decide two things: whether the flagged device is one the section's named voice calls for (Hitchens's antithesis, Taleb's aphorism, Feynman's carried metaphor), and whether it serves the piece. When both hold, keep the sentence and record the finding as standing, naming the voice it serves. When either fails, fix it. A fact-checker SHOULD_FIX is resolved or recorded standing with the reason.
5. **Re-run the mechanical checks yourself.** Over the fixed draft, run the mechanical items of the Final Slop Check: banned vocabulary, em-dashes, banned phrases and structures, leakage, placeholders. This is the second slop pass; the hunter's one dispatch was the first.
6. **Re-dispatch `blog-fact-checker` once**, the same way. If it still returns BLOCKING findings, stop: a draft that cannot clear two fact-check passes goes to the user, not into another rewrite.
7. **Present the draft to the user** with every finding from both agents, marked resolved or standing with the reason (for a standing slop finding, the voice it serves), the hunter's KEEP list, and the fact checker's rebuttal paragraph and weakest sentence verbatim. The user rules on what stands.

### Step 5: Revise

Incorporate feedback. Repeat until the user approves. Then run `blog-fact-checker` once more on the approved text, since the user's edits can add claims; resolve any BLOCKING finding it returns and show the user what changed. Finally set `draft: false`.

---

## Output Format

Every blog post is a single `.mdx` file with this frontmatter:

```mdx
---
title: 'Why Your AI Conversations Should Be Encrypted'
description: 'A short meta description for SEO and social cards, under 160 characters.'
author: 'Alex Chen'
date: 2026-03-27
tags: ['privacy', 'encryption']
draft: false
---

Post body here.

---

## Sources

1. [OpenAI Privacy Policy](https://openai.com/privacy)
2. [OPAQUE: An Asymmetric PAKE Protocol](https://eprint.iacr.org/2018/163)
```

Every post ends with a `## Sources` section: one source per line, numbered in order of first use, each line in exactly this shape:

```
N. [Article title exactly as the page names it](url)
```

The link text is the page's own title, verbatim, and the line ends at the closing parenthesis. Body text carries no citation markers; a sentence that rests on a source names the outlet or author in prose ("Help Net Security reported..."), and the reader finds the entry by its title. Every external factual claim has an entry. A HushBox claim verified by reading the code needs none. Sources are rendered as colored clickable links.

**File naming convention:** Slugified title, lowercase, hyphens. Example: `why-your-ai-conversations-should-be-encrypted.mdx`

---

## Visuals

A visual earns its place only where it replaces prose: a comparison a table shows faster than three sentences, a flow a diagram shows faster than a paragraph. Where a sentence says the same thing, write the sentence. Never add a visual as decoration.

What the blog renders, verified against `apps/marketing`:

- **Tables.** GitHub-flavored Markdown tables, styled by the blog's prose styles. The first choice for any comparison.
- **Code blocks.** Fenced blocks are syntax-highlighted at build.
- **Images.** A file under `apps/marketing/src/assets/blog/<post-slug>/`, referenced by a Markdown image line, is optimized at build. Every image carries alt text that states what the picture shows. Never reference a hosted image: a third-party fetch on a privacy blog is a claim against the brand.
- **Charts and diagrams.** An Astro component under `apps/marketing/src/components/blog/visuals/`, imported at the top of the MDX file. Astro only, never React: a `.astro` component renders to static HTML at build with nothing to hydrate, so the visual is in the crawled page and ships no runtime. Hand-build it as inline SVG or plain elements in the site's semantic color tokens so it follows the theme; the raw-palette guard covers the web app, not the marketing site, so this rule is the only enforcement. Put the data and any geometry math in a TypeScript module beside the component, unit-tested, never inline in the MDX; the fact checker reads that module and every number in it is a factual claim needing a Sources entry like any sentence. Put the numbers beside the visual as text too. `CostComparison.astro` is the static pattern; the stats components show the geometry-module split. Load the `dataviz` skill before building one.
- **Not available.** Mermaid fences render as code blocks, not diagrams. No chart library exists in the marketing app; adding one is a dependency decision for the user.

Keep at least one empty line above and one below every table, blockquote, image line, and imported component.

---

## Quotations

Quote inline, inside the paragraph, with the speaker named in the same sentence: `The vendor's notice to affected users put it plainly: "the sessions were hijacked by malware on the user's device."` Reserve a Markdown blockquote for a quotation longer than two sentences, and make the block's last line its speaker, so the attribution renders inside the quote. Place the first blockquote after the first section heading.

---

## Voice

### Influences — Combine as the Topic Demands

No single voice dominates. Draw from several depending on what the section needs:

**Thomas Aquinas** — Steelman the opposition's best argument, then dismantle it with patient logic. Use when addressing counterarguments, competitor defenses, or "but what about..." objections. Never straw-man. Present the strongest version of the other side, then answer it.

**George Orwell** — Say what you mean at the cost of comfort. Translate corporate euphemism into plain truth. When a competitor says "we may use your data to improve our services," this voice says what that actually means. No hedging, no softening, no weasel words.

**Richard Feynman** — Explain complex things with joy and zero condescension, as if talking to a smart friend at a bar. Use for technical explainers: cryptography, protocols, architecture. Assume the reader is intelligent but not specialist. If you use a technical term, explain it immediately. If the explanation is longer than the term, use the explanation instead.

**Christopher Hitchens** — Morally uncompromising, rhetorically sharp. Make the reader feel foolish for having accepted the status quo. Use for conclusions, calls to action, and pieces where you're making a moral argument about privacy or data rights. Earn moral authority through argument, don't assert it.

**Paul Graham** — Build from first principles, conversational register, treat the reader as an intelligent peer. Use for comparison pieces, economic arguments, and "the true cost of X" posts. The voice HN and Reddit audiences already respect.

**Nassim Taleb** — Follow the money and the incentives. Expose asymmetries where one party bears risk and another profits. Use for pricing model comparisons, subscription vs. pay-per-use arguments, and any discussion of business model alignment.

### Voice Blending in Practice

A single post might use:

- Feynman's clarity for the technical explainer section
- Aquinas's structure when addressing counterarguments
- Orwell's directness when comparing competitor privacy policies
- Taleb's incentive-tracing when discussing pricing models
- Hitchens's moral urgency in the conclusion

The voice should never feel like a costume. It should feel like the natural way a principled, technically fluent person would explain this topic to someone they respect.

### Core Adjectives for All Posts

Lucid. Principled. Unhurried. Precise. Confident without arrogance. Technically honest.

---

## Anti-Slop Rules

This is the most important section of this skill. AI-generated writing has recognizable fingerprints. HushBox's blog must read as if a human with strong opinions and deep knowledge wrote it. Every draft MUST pass this checklist before being shown to the user.

## Banned Vocabulary

If any of these words appear in the draft, replace them or restructure the sentence. No exceptions.

**Verbs:** delve, leverage, utilize, harness, streamline, underscore, embark, navigate (as metaphor), endeavour, elevate, foster, encompass, showcase, boast, bolster, garner, surpass, unveil, exemplify

**Adjectives:** pivotal, robust, innovative, seamless, cutting-edge, groundbreaking, transformative, multifaceted, compelling, meticulous, vibrant, commendable, paramount, invaluable, comprehensive, crucial, vital, intricate, nuanced, renowned, profound, enduring

**Nouns:** landscape (digital/technological), realm, tapestry, synergy, testament, underpinnings, beacon, paradigm, journey (metaphorical), insight, interplay, ecosystem

**Transitions:** furthermore, moreover, consequently, notably, importantly, indeed, notwithstanding, additionally

**Filler phrases:** "it's important to note," "it's worth noting," "it bears mentioning," "one might argue," "from a broader perspective," "generally speaking," "to some extent"

**Filler adverbs:** effectively, efficiently, successfully, significantly, surprisingly, simply, seamlessly, ultimately, particularly, primarily

## Banned Phrases & Openers

Never begin a draft, section, or paragraph with any of these:

- "In today's ever-evolving..."
- "In the fast-paced world of..."
- "As we navigate the complexities of..."
- "In conclusion / In summary / In essence..."
- "Imagine a world where..."
- "Let's dive in / Let's unpack this"
- "In an era where..."
- "It's no secret that..."
- "When it comes to..."
- "Great question / You're absolutely right / Great catch" (sycophantic praise)

Never use these structures anywhere:

- "It's not just X, it's Y"
- "This is where X comes in"
- "X is more than just Y; it's Z"
- "It wasn't X, it was Y" (false-contrast kicker)
- "X rather than Y" (false contrast, same family)
- "Here's the thing / Here's the kicker / But here's the truth / That's only half the story" (fake-suspense reveals)
- "Some critics argue / Experts argue / Studies show / Industry reports" (vague attribution — name the real source or cut the claim)

Never end a draft or section with any of these:

- "At the end of the day..."
- "Ultimately,..."
- "It goes without saying..."
- "Without further ado..."

## Banned Structural Patterns

**No em-dashes.** Never use em-dashes. Use commas, semicolons, colons, periods, or parentheticals instead. Zero tolerance.

**Rule of three.** Do not list three adjectives, three short phrases, or three parallel clauses unless you are making a genuinely tripartite point. "Fast, secure, and private" is a real triad. "Dynamic, innovative, and transformative" is slop.

**Uniform paragraph length.** Vary deliberately. A one-sentence paragraph after a long one creates emphasis. A five-sentence paragraph after two short ones creates depth. If all paragraphs are 3-4 sentences, you've written AI slop.

**Hedging into oblivion.** Take positions. Say "this is worse" not "this may potentially be considered less optimal by some." Drafts have opinions.

**Mic-drop kickers on every section.** Two punchy closing lines per piece, maximum. If every section ends with a one-liner meant to land like a hammer, none of them land. Most sections should end mid-thought, or with a transition, or just... stop.

**Recursive summarization.** Do not restate what you just said in different words. If the previous paragraph explained how X works, the next paragraph should not begin with "In other words, X ensures that..." Move forward.

**Mechanical bold formatting.** Do not bold key terms as if making "key takeaways" from a slide deck. Bold is for emphasis of specific words in specific moments, not for highlighting every occurrence of a concept.

**Avoiding contractions.** Use them. "You'll" not "You will." "Can't" not "Cannot." "It's" not "It is." Unless formality is doing specific rhetorical work, write like a person talks.

**Copulative avoidance.** Don't dress up "is" and "are." "The gallery serves as an exhibition space" is slop for "The gallery is an exhibition space." Watch for "serves as / stands as / functions as / represents" standing in for a plain "is."

**Editorializing significance.** Don't tell the reader something matters. No "stands as a testament to," "underscores its significance," "left an indelible mark," "a key turning point," or "reflects a broader." State the fact and let it carry its own weight.

**Elegant variation.** Don't reach for synonyms to avoid repeating a word. If it's a wallet, call it a wallet every time, not "the wallet," then "the billfold," then "the payment vessel." Repetition beats a thesaurus parade.

**Rigid section scaffolding.** Don't force a canned skeleton of "Challenges," "Future Prospects," "Legacy," or a self-summarizing "Conclusion" section. Let the structure follow the content.

## Leakage & Placeholders

None of this belongs in anything you show a human. Scan for it and cut it.

- **No AI self-disclosure.** Never write "As an AI language model" or "as a large language model."
- **No knowledge-cutoff disclaimers.** Never write "As of my last knowledge update," "up to my last training update," "based on available information," or "while details are scarce." If you don't know, find out or say nothing.
- **No leaked assistant framing.** Never emit chat pleasantries: "Certainly!," "Of course!," "I hope this helps," "Would you like me to...," "let me know," "is there anything else."
- **No shipped placeholders.** Never leave a bracket or stub in final output: `[Your Name]`, `[insert X]`, `access-date=2025-XX-XX`, `PASTE_URL_HERE`. Fill it or cut it.

## What to Do Instead

- **Vary sentence length dramatically.** A long sentence that builds and qualifies and extends, followed by a short one. Then medium.
- **Use specific numbers, dates, names.** Not "many users" but "2.3 million users." Not "recently" but "in January 2026." Not "a major AI company" but "OpenAI."
- **Include sensory and concrete details.** Instead of "the experience is seamless," describe what actually happens: "You type your password. Nothing leaves your device. The server never sees it."
- **Have opinions.** Drafts are not Wikipedia articles. They argue positions.
- **Leave some threads open.** Not every point needs a neat conclusion. Sometimes the most powerful move is to present a fact and let the reader sit with it.
- **Break a grammar rule when it sounds better.** Start a sentence with "And" or "But." Use a fragment for emphasis. End on a preposition if the alternative sounds stilted.

## The Final Slop Check

Before presenting any draft, run this exact checklist:

1. Ctrl+F every word in the banned vocabulary list. Replace all hits.
2. Read the first sentence of every paragraph. If more than two start with the same word or structure, rewrite.
3. Search for em-dashes. If any exist, replace them. Zero allowed.
4. Check paragraph lengths. If three consecutive paragraphs are the same length (within one sentence), rewrite one.
5. Read the last sentence of every section. If more than two are "kickers" (short, punchy, meant to land hard), keep the best two and rewrite the rest.
6. Search for "not just...but" and "more than just...it's" constructions. Delete all of them.
7. Read the entire draft aloud (mentally). Flag anything that sounds like a press release, a LinkedIn post, a college application essay, or AI-generated boilerplate. Rewrite those parts.
8. Scan for leaked assistant framing, AI self-disclosure, knowledge-cutoff disclaimers, and unfilled placeholders. Delete every one.

---

## Data Integrity Rules

Every factual claim must be verified. There are two sources of truth:

1. **The internet** — for competitor features, pricing, industry stats, news, and general technical facts. Always search. Never cite from memory. If you can't find a source, don't make the claim.
2. **The HushBox codebase** — for anything about HushBox's own features, architecture, or implementation. Read the actual code in `apps/` and `packages/`, not just documentation files. If the post says "HushBox uses OPAQUE for authentication," you must have read the OPAQUE implementation in `packages/crypto/` and confirmed this is true in the current code.

**Never:**

- Invent statistics
- Describe a competitor's feature without checking their current documentation
- Describe a HushBox feature without reading the code
- Use phrases like "studies show" without a specific study
- Round numbers in a misleading direction

**If you're unsure, say so in the post.** "We haven't independently verified this claim" is better than presenting an unverified number as fact. Honesty is a brand pillar.
