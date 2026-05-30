---
name: anti-ai-writing
description: Anti-slop checklist for AI-generated writing. Invoke before producing any prose draft (tickets, posts, comments, docs, PR descriptions) to catch AI fingerprints. Apply the Final Slop Check before showing any draft to the user. May be invoked by the main agent, write-blog, write-task, backfill-linear, or any other agent or skill producing prose.
---

# Anti-Slop Rules

AI-generated writing has recognizable fingerprints. Output must read as if a human with strong opinions and concrete knowledge wrote it. Every draft must pass this checklist before being shown to the user.

> Sync: this content is duplicated in `.claude/skills/write-blog/SKILL.md` (Anti-Slop Rules), `.claude/agents/linear-task-manager.md` (Anti-Slop Rules), and `.claude/skills/backfill-linear/SKILL.md` (Anti-Slop Rules). If you modify rules here, update those files to match.

## Banned Vocabulary

If any of these words appear in the draft, replace them or restructure the sentence. No exceptions.

**Verbs:** delve, leverage, utilize, harness, streamline, underscore, embark, navigate (as metaphor), endeavour, elevate, foster, encompass

**Adjectives:** pivotal, robust, innovative, seamless, cutting-edge, groundbreaking, transformative, multifaceted, compelling, meticulous, vibrant, commendable, paramount, invaluable, comprehensive, crucial, vital

**Nouns:** landscape (digital/technological), realm, tapestry, synergy, testament, underpinnings, beacon, paradigm, journey (metaphorical)

**Transitions:** furthermore, moreover, consequently, notably, importantly, indeed, notwithstanding

**Filler phrases:** "it's important to note," "it's worth noting," "it bears mentioning," "one might argue," "from a broader perspective," "generally speaking," "to some extent"

**Filler adverbs:** effectively, efficiently, successfully, significantly, surprisingly, simply, seamlessly

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

Never use these structures anywhere:

- "It's not just X, it's Y"
- "This is where X comes in"
- "X is more than just Y; it's Z"
- "It wasn't X, it was Y" (false-contrast kicker)

## Banned Structural Patterns

**No em-dashes.** Never use em-dashes. Use commas, semicolons, colons, periods, or parentheticals instead. Zero tolerance.

**Rule of three.** Do not list three adjectives, three short phrases, or three parallel clauses unless you are making a genuinely tripartite point. "Fast, secure, and private" is a real triad. "Dynamic, innovative, and transformative" is slop.

**Uniform paragraph length.** Vary deliberately. A one-sentence paragraph after a long one creates emphasis. A five-sentence paragraph after two short ones creates depth. If all paragraphs are 3-4 sentences, you've written AI slop.

**Hedging into oblivion.** Take positions. Say "this is worse" not "this may potentially be considered less optimal by some." Drafts have opinions.

**Mic-drop kickers on every section.** One punchy closing line per piece, maximum. If every section ends with a one-liner meant to land like a hammer, none of them land. Most sections should end mid-thought, or with a transition, or just... stop.

**Recursive summarization.** Do not restate what you just said in different words. If the previous paragraph explained how X works, the next paragraph should not begin with "In other words, X ensures that..." Move forward.

**Mechanical bold formatting.** Do not bold key terms as if making "key takeaways" from a slide deck. Bold is for emphasis of specific words in specific moments, not for highlighting every occurrence of a concept.

**Avoiding contractions.** Use them. "You'll" not "You will." "Can't" not "Cannot." "It's" not "It is." Unless formality is doing specific rhetorical work, write like a person talks.

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
5. Read the last sentence of every section. If more than one is a "kicker" (short, punchy, meant to land hard), keep the best one and rewrite the rest.
6. Search for "not just...but" and "more than just...it's" constructions. Delete all of them.
7. Read the entire draft aloud (mentally). Flag anything that sounds like a press release, a LinkedIn post, a college application essay, or AI-generated boilerplate. Rewrite those parts.
