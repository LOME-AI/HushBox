---
name: write-blog
description: Write a blog post for the HushBox marketing site (hushbox.ai/blog). Use this skill whenever the user wants to create, draft, plan, or iterate on a blog post. Trigger on mentions of "blog", "blog post", "write a post", "new article", "content for the blog", or any reference to hushbox.ai/blog content creation. This skill handles the full lifecycle — topic research, outline, drafting, anti-slop review, and final MDX file output. It does NOT handle the Astro engineering setup (content collection config, page templates, RSS feed) — only the content creation workflow.
argument-hint: Topic and author — e.g. "Why your AI conversations should be encrypted — author: Sarah Chen"
---

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

{{BLOG_VOICE}}

---

## Anti-Slop Rules

This is the most important section of this skill. AI-generated writing has recognizable fingerprints. HushBox's blog must read as if a human with strong opinions and deep knowledge wrote it. Every draft MUST pass this checklist before being shown to the user.

{{ANTI_SLOP_CHECKLIST}}

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
