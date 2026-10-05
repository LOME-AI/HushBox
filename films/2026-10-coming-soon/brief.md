# Coming Soon: brief

Agreed with the founder on 2026-10-02. The founder gave the director full freedom on every decision for the round-1 draft; the decisions below marked "director's" were taken under that freedom and stay open to change.

## The idea

A question she keeps deleting becomes the cinema she opens.

- A: she types "is it crazy to quit my job" and deletes it. The deleted letters do not vanish: they fall and pile up.
- B: at dawn she spells OPEN on her cinema's letter board with letters taken from that pile.

Between them, the answers to the one question she finally sends build the cinema (a chart from code becomes the rows of seats; a web search lays the street; an image model draws the sign; several models answer one question and she picks a name). At night the conversation papers the cinema's glass doors from inside, writing facing her: from the street, blank paper, a small Signal Red spiral and "COMING SOON"; at dawn she peels it down.

## References

The founder named no reference clip. Round 1 makes three takes that differ in kind:

- an Apple-keynote launch film: one continuous take, every scene made out of the previous one;
- an animated short in storybook line art, led by its character;
- a kinetic-typography music video: everything, the cinema included, built from letters, cut hard on the beat.

## Explicit instructions

Verbatim from the founder, 2026-10-02:

> I need an amazing, super high quality motion design animation to show to investors, pitching the product to a new audience. it should be generic, nothing specific like asking for money or mentioning its a pitch, also able to be put online.

> i want something memorable, a story, show dont tell, it should be a work of art, expressing the value implicitly, not explicitly, think of more ideas but it must still be obvious what we are advertising. it must be intuitive for a first time viewer

> i give you full freedom on decisions for round 1 draft. execute.

## Director's decisions for round 1

- The concept is "Coming Soon", the survivor of five rounds of blind first-viewer tests, hostile creative review and prior-art search held on 2026-10-02 (findings below).
- 30 s, one piece, vertical 1080×1920 (the engine's only frame), music and effects only, no voice.
- One handwritten note taped to the papered doors: "Not even we can read it." Every round of testing found that privacy shown by picture alone did not register (trust 2–4/10); this note answers "private from whom" inside the picture. Its basis is a fact (below).
- The dream is a one-screen cinema, not a food shop: "COMING SOON" is a cinema's own phrase, and AI-helps-open-a-small-food-business is this year's category default (OpenAI "Start It With ChatGPT", 2026-02; ChatGPT Japan's donut-shop spot, 2026-08).
- She is on screen from the first shot (a simple figure, a hand, a silhouette: the take decides), so the film is hers and the AI is her help, not the hero.
- The deleted letters stay in her private space (inside the cinema, behind the doors), never lying on a public street.

## Facts a take may show

Every picture of HushBox must be true at its exact boundary. Established from the code and the live catalog on 2026-10-02:

- Typing in a one-to-one chat sends nothing until Send; only the line she sends leaves (`apps/web/src/hooks/chat/use-chat-page.ts:38`). Never show deleted letters being sent.
- On Send the message goes in plaintext to HushBox's server and on to the chosen model's provider, which reads it to answer (`packages/shared/src/schemas/api/conversations.ts:221-222`, `apps/api/src/slices/models/adapters/language-adapter.ts:52-56`). Never show a message sealed or hidden in flight, or a model that cannot see it.
- Stored conversations are encrypted and HushBox cannot read them; only her key opens them (`packages/db/src/schema/content-items.ts:31`, `packages/crypto/src/account.ts:18-55`). They are stored on HushBox's servers and sync to her devices, so the sealed record is not "in her pocket only". The papered doors and the note are this fact.
- HushBox routes only to providers committed to zero data retention (`packages/shared/src/models/routing-options.ts:63-70`); that they keep nothing is the provider's pledge, so a take does not show a model visibly forgetting as proven fact.
- One reply carries one model's full name, e.g. "Claude Sonnet 5.5" (`apps/web/src/components/chat/message/model-nameplate.tsx:64-69`). Several models answering one message stack one under another, at most five (`packages/shared/src/constants.ts:101`). Models answer turns; a turn's model is the one she picked.
- Model names that may appear, from the live admission filter on 2026-10-02: GPT-5.5, Claude Sonnet 5.5, Gemini 3.1 Pro, Gemini 3.8 Flash, Llama 4 Maverick, Mistral Large 3, Qwen3.8 27B; images: Seedream 5.0 only (no FLUX). Web search shows as a row "Searched the web · N sources" from a tool-capable model such as Gemini 3.1 Pro. Code from any model's answer runs in the document panel beside the chat (`docs/DOCUMENTS.md`).

## What the concept testing found

- The one image every viewer remembered and no ad owns: deleted letters that pile up instead of vanishing. The papered doors and the conversation-built cinema are the other fresh images.
- One model answering first and largest read as "a Claude ad"; many brand names as characters read as "a wrapper" and cut trust. Show the model list once as abundance; let nameplates be small and true; no DeepSeek on screen.
- Sad or confessional questions read as a therapy app; the hopeful secret does not.
- Worn and to avoid: a threat that fills the screen and vanishes when the hero switches app; eyes and watchers; padlocks; split-flap boards; a chart line becoming a skyline.
- Viewers watch muted: every point lands as picture or on-screen text.

## Length

30 s, one piece.
