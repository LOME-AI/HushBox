/**
 * The conversations the dev and screenshot rosters are seeded with, and the
 * corpora they are made of.
 */

import { createDevConversation, createDevGroupChat } from '@hushbox/api/dev-seed';
import { mapWithConcurrency } from '@hushbox/shared';
import { PRESENCE_ONLY_MODELS } from '../playwright/model-ids.js';
import { DOCUMENT_SHOWCASE_MESSAGES, DOCUMENT_SHOWCASE_TITLE } from './documents.js';
import { SCREENSHOT_CONVERSATIONS } from './fixtures.js';
import { devEmail, seedUUID } from './personas.js';
import type { Database } from '@hushbox/db';
import type { FixtureMessageSpec } from './fixtures.js';
import type { DevPersona } from './personas.js';

/**
 * A known model id stamped on seeded AI messages. `model_id` is a plain text
 * column with no FK to `model_catalog`, but the declared id is one the live
 * catalog (populated by `catalog:refresh`) exposes, so a seeded turn references
 * a model the picker renders — and `assertE2eModelsPresent` reddens when a
 * gateway retirement takes that away.
 */
export const SEED_MODEL_ID = PRESENCE_ONLY_MODELS.primary;

/** Charlie's small standalone conversation (legacy parity: a non-empty convo). */
export const CHARLIE_CONV_MESSAGES: readonly { content: string; senderType: 'user' | 'ai' }[] = [
  { content: 'What is the difference between TCP and UDP?', senderType: 'user' },
  {
    content:
      'TCP is connection-oriented and reliable (ordered, retransmitted delivery); UDP is connectionless and best-effort (lower latency, no delivery guarantees).',
    senderType: 'ai',
  },
];

function toFactoryMessage(message: FixtureMessageSpec): {
  content: string;
  senderType: 'user' | 'ai';
} {
  return { content: message.text, senderType: message.sender === 'ai' ? 'ai' : 'user' };
}

/**
 * The screenshot conversation title, matching the legacy `Screenshot: ${name}`
 * corpus. The `name` is the descriptive suffix of the seed key
 * (`screenshot-conv-chat` → `chat`), which is what legacy named these by.
 */
export function screenshotConversationTitle(seedKey: string): string {
  return `Screenshot: ${seedKey.replace(/^screenshot-conv-/, '')}`;
}

/** Seeds the five curated screenshot conversations; returns their ids in order. */
export async function seedScreenshotConversations(db: Database): Promise<string[]> {
  const conversationIds: string[] = [];
  for (const spec of SCREENSHOT_CONVERSATIONS) {
    const id = seedUUID(spec.seedKey);
    const title = screenshotConversationTitle(spec.seedKey);
    if (spec.members === undefined) {
      await createDevConversation(db, {
        ownerEmail: devEmail(spec.ownerPersona),
        seedAiModel: SEED_MODEL_ID,
        id,
        title,
        messages: spec.messages.map((message) => toFactoryMessage(message)),
      });
    } else {
      await createDevGroupChat(db, {
        ownerEmail: devEmail(spec.ownerPersona),
        memberEmails: spec.members
          .filter((name) => name !== spec.ownerPersona)
          .map((name) => devEmail(name)),
        seedAiModel: SEED_MODEL_ID,
        id,
        title,
        messages: spec.messages.map((message) => ({
          content: message.text,
          senderType: message.sender === 'ai' ? ('ai' as const) : ('user' as const),
          senderEmail: message.sender === 'ai' ? undefined : devEmail(message.sender),
        })),
      });
    }
    conversationIds.push(id);
  }
  return conversationIds;
}

/** A generated sample conversation for a dev persona (pre-persistence spec). */
interface PersonaSampleConversation {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly { content: string; senderType: 'user' | 'ai' }[];
}

/**
 * The zero-based index whose generated conversation is the search-tool demo
 * (`'Quantum Computing Research'`) rather than a generic per-persona thread —
 * mirrors the legacy `convIndex === 2` carve-out.
 */
const SEARCH_CONVERSATION_INDEX = 2;

/**
 * The four canned messages of the search-tool demo conversation, reproducing the
 * legacy `SEARCH_MESSAGES` corpus (a user question, a cited web-search answer,
 * a follow-up, and a second cited answer) so the seeded thread renders the
 * search-result markdown the demo screenshots rely on.
 */
const SEARCH_CONVERSATION_MESSAGES: readonly { content: string; senderType: 'user' | 'ai' }[] = [
  { content: 'What are the latest developments in quantum computing?', senderType: 'user' },
  {
    content:
      'Based on recent web results, here are the latest developments in quantum computing:\n\n' +
      'According to [nature.com](https://nature.com/articles/quantum-2024), researchers have ' +
      'achieved a major breakthrough in error correction, demonstrating logical qubits with ' +
      'error rates below the threshold needed for practical computation.\n\n' +
      'A recent paper on [arxiv.org](https://arxiv.org/abs/2401.00001) describes a new ' +
      'approach to topological quantum computing that could make systems more stable at ' +
      'higher temperatures.',
    senderType: 'ai',
  },
  {
    content: 'How does this compare to classical computing for optimization problems?',
    senderType: 'user',
  },
  {
    content:
      'Quantum computing shows significant advantages for specific optimization problems:\n\n' +
      'According to [science.org](https://science.org/quantum-optimization), quantum annealers ' +
      'have demonstrated up to 100x speedups on certain combinatorial optimization tasks ' +
      'compared to classical solvers.\n\n' +
      'However, as noted by [ieee.org](https://spectrum.ieee.org/quantum-classical), for many ' +
      'real-world problems classical algorithms remain competitive, and the crossover point ' +
      'depends heavily on problem structure and size.',
    senderType: 'ai',
  },
];

/** Generic thread: `3 + (index % 3)` messages, alternating user (even) / ai (odd). */
function buildGenericSampleMessages(
  personaName: string,
  conversationIndex: number
): { content: string; senderType: 'user' | 'ai' }[] {
  const messageCount = 3 + (conversationIndex % 3);
  return Array.from({ length: messageCount }, (_, messageIndex) => ({
    senderType: messageIndex % 2 === 0 ? ('user' as const) : ('ai' as const),
    content: `${personaName} message ${(conversationIndex + 1).toString()}-${(messageIndex + 1).toString()}`,
  }));
}

/**
 * Builds the bulk per-persona sample conversations (the legacy
 * `createPersonaSampleData` scale): `conversationCount` deterministic-id
 * conversations titled `${personaName} Conversation ${n}`, except the third
 * (`SEARCH_CONVERSATION_INDEX`) which is the `'Quantum Computing Research'`
 * search-tool demo. Pure/deterministic so the scale and shape are unit-tested;
 * {@link seedBulkSampleConversations} persists the result through the dev factory.
 */
export function buildPersonaSampleConversations(
  personaName: string,
  conversationCount: number
): PersonaSampleConversation[] {
  return Array.from({ length: conversationCount }, (_, conversationIndex) => {
    const isSearch = conversationIndex === SEARCH_CONVERSATION_INDEX;
    return {
      id: seedUUID(`${personaName}-conv-${(conversationIndex + 1).toString()}`),
      title: isSearch
        ? 'Quantum Computing Research'
        : `${personaName} Conversation ${(conversationIndex + 1).toString()}`,
      messages: isSearch
        ? SEARCH_CONVERSATION_MESSAGES
        : buildGenericSampleMessages(personaName, conversationIndex),
    };
  });
}

/**
 * The dev personas that receive the bulk sample-data generator — the
 * `hasSampleData` gate (legacy's `if (persona.hasSampleData)` branch). Non-sample
 * personas are excluded entirely, so their `sampleConversationCount` is inert.
 */
export function personasWithSampleData(roster: readonly DevPersona[]): DevPersona[] {
  return roster.filter((persona) => persona.hasSampleData);
}

/** One persona's seeded document-showcase conversation. */
interface DocumentShowcaseConversation {
  id: string;
  ownerEmail: string;
  title: string;
  messages: readonly { content: string; senderType: 'user' | 'ai' }[];
}

/**
 * One showcase conversation per dev persona, so the document panel's every path
 * is one click away whichever persona a developer logs in as. Ids derive from
 * the persona name, so a re-seed rewrites the same rows instead of adding more.
 */
export function buildDocumentShowcaseConversations(
  roster: readonly DevPersona[]
): DocumentShowcaseConversation[] {
  return roster.map((persona) => ({
    id: seedUUID(`${persona.name}-document-showcase`),
    ownerEmail: devEmail(persona.name),
    title: DOCUMENT_SHOWCASE_TITLE,
    messages: DOCUMENT_SHOWCASE_MESSAGES,
  }));
}

/** Persists the per-persona showcase conversations; returns the count seeded. */
export async function seedDocumentShowcases(
  db: Database,
  roster: readonly DevPersona[]
): Promise<number> {
  const showcases = buildDocumentShowcaseConversations(roster);
  for (const showcase of showcases) {
    await createDevConversation(db, {
      ownerEmail: showcase.ownerEmail,
      seedAiModel: SEED_MODEL_ID,
      id: showcase.id,
      title: showcase.title,
      messages: [...showcase.messages],
    });
  }
  return showcases.length;
}

/**
 * Persists every given persona's bulk sample conversations, at most
 * `concurrency` at once; returns the count created. Each conversation writes
 * only its own rows, so the one thing running them side by side changes is the
 * recency order among them.
 */
export async function seedBulkSampleConversations(
  db: Database,
  personas: readonly DevPersona[],
  concurrency: number
): Promise<number> {
  const conversations = personas.flatMap((persona) =>
    buildPersonaSampleConversations(persona.name, persona.sampleConversationCount).map(
      (conversation) => ({ ownerEmail: devEmail(persona.name), conversation })
    )
  );
  await mapWithConcurrency(conversations, concurrency, ({ ownerEmail, conversation }) =>
    createDevConversation(db, {
      ownerEmail,
      seedAiModel: SEED_MODEL_ID,
      id: conversation.id,
      title: conversation.title,
      messages: conversation.messages,
    })
  );
  return conversations.length;
}
