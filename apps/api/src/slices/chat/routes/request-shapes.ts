import { z } from 'zod';
import {
  buildTurnSystemPrompt,
  historyCharacterCount,
  promptCharacterCount,
  stripReplayHistory,
  utcDayKey,
} from '@hushbox/shared';
import {
  hashRequestBody,
  mockProviderEnabled,
  parseMockDirectives,
  readIdempotencyKey,
} from '../domain/index.js';
import type { Context } from 'hono';
import type {
  ChatHistoryMessage,
  EnvContext,
  MockDirectives,
  regenerateTurnBodySchema,
  startTurnBodySchema,
} from '@hushbox/shared';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';

export const conversationIdParameterSchema = z.object({ conversationId: z.uuid() });

/**
 * The dev-only held-stream release query: the room whose parked stream to free,
 * and optionally the run to free within it. Naming the run is what lets a
 * release land before that run has started — the room's latch is keyed to the
 * run key, so an unnamed release means whichever run the room currently holds.
 */
export const releaseStreamQuerySchema = z.object({
  conversationId: z.string().min(1),
  runKey: z.string().min(1).optional(),
});

/** The ConversationRoom DO's `{ released }` reply to the internal release fetch. */
export const releaseStreamResponseSchema = z.object({ released: z.boolean() });

/**
 * A minimal structural view of the ConversationRoom DO namespace, declared
 * locally (the `realtime-do.ts` pattern) so this dev-only test hook needs no
 * `@cloudflare/workers-types` ambient globals and no cross-slice import. The env
 * widening (`extends EnvContext`) keeps `Bindings` — which does not declare the
 * namespace — assignable despite the otherwise-weak optional shape.
 */
interface ReleaseStreamRoomNamespace {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): { fetch(input: string, init?: RequestInit): Promise<Response> };
}
export interface ReleaseStreamRoomEnv extends EnvContext {
  readonly CONVERSATION_ROOM?: ReleaseStreamRoomNamespace;
}

export function randomUuid(): string {
  return crypto.randomUUID();
}

/**
 * The ONE seam that decides the resent history's bytes. Absent and [] must be
 * indistinguishable everywhere downstream — the body hash (a client upgrade
 * must never cause a spurious 409) and the run body — and embedded reasoning is
 * stripped HERE, ahead of the hash, the prompt count, the classifier excerpt
 * and the run body alike, so the turn is priced, deduped, classified and sent
 * over identical bytes. Nothing downstream strips again: this seam is the one
 * mechanism for the job, and every consumer reads the bytes it decided.
 *
 * Cleaning is idempotent: cleaned history text never begins with the frame
 * marker, so a turn the client already cleaned cleans to the same bytes here,
 * and a turn cleaned once or twice hashes the same. One pass is linear in the
 * text however a client nests it, because frames are read by length.
 */
export function normalizedHistory(history: ChatHistoryMessage[] | undefined): ChatHistoryMessage[] {
  return [...stripReplayHistory(history ?? [])];
}

/**
 * The per-request deterministic-inference directives to put on the run-start
 * body, spread so the field is set ONLY in dev/E2E (where `x-mock-*` headers are
 * honored). In production `mockProviderEnabled` is false, so the headers are
 * never read and the field is never set — the mock is unreachable regardless of
 * what a client sends. The runtime additionally re-gates on env mode, so this is
 * the outer of two independent production-inert guards.
 */
export function mockDirectivesBody(c: Context<AppEnv>): { mockDirectives?: MockDirectives } {
  return mockProviderEnabled(c.var.envUtils)
    ? { mockDirectives: parseMockDirectives((name) => c.req.header(name)) }
    : {};
}

/**
 * The run-scoped custom-instructions field for a RunStartBody, present only when
 * the client supplied it. Threaded to the executor as run context, deliberately
 * NOT into the definition — the WorkflowDefinition must stay free of user content
 * so it remains safe to log.
 */
export function runScopedInstructions(body: { readonly customInstructions?: string | undefined }): {
  customInstructions?: string;
} {
  return body.customInstructions === undefined
    ? {}
    : { customInstructions: body.customInstructions };
}

/**
 * The characters the model will see — the built system prompt (base preamble
 * + optional custom instructions), every resent history turn, and the current
 * prompt — measured through the ONE shared counter the composer preview uses,
 * so admission and preview price the identical prompt. The date line the
 * builder renders is fixed-width, so the count is clock-independent.
 */
export function turnPromptCharacterCount(
  body: { readonly customInstructions?: string | undefined },
  prompt: string,
  history: readonly ChatHistoryMessage[]
): number {
  return promptCharacterCount({
    systemPrompt: buildTurnSystemPrompt({
      utcDay: utcDayKey(new Date()),
      ...runScopedInstructions(body),
    }),
    historyCharacters: historyCharacterCount(history),
    prompt,
  });
}

/**
 * The request's `Idempotency-Key`. The pipeline enforced the header before the
 * handler ran: a chat turn forwards it to the conversation DO as the run key,
 * whose referee claims it there, and the user-only send claims it here through
 * `idempotent.byKey`. Absence here is a composition defect.
 */
export function requiredIdempotencyKey(c: Context<AppEnv>): string {
  const key = readIdempotencyKey(c);
  /* v8 ignore next 3 -- the idempotency-key middleware enforces the key on every non-exempt mutating route before the handler runs; this guard is a defect-only invariant */
  if (key === undefined) {
    throw new Error('chat: idempotency key missing after the pipeline stage');
  }
  return key;
}

/**
 * The user-only send's response: the id it minted for the stored row. It is
 * stored on the send's key row, and a resend's replay is validated against it.
 */
export const userOnlyMessageResponseSchema = z.object({
  messageId: z.uuid(),
  sequenceNumber: z.number().int().nonnegative(),
  epochNumber: z.number().int().positive(),
});

/**
 * The canonical dedup body for a start turn — only the client-intent fields
 * that identify the run (the server-derived context is bound to the run body,
 * not the hash). Every optional is spread only when meaningfully present so a
 * client upgrade (adding a defaulted field) never causes a spurious 409: an
 * omitted vs `[]` history, a default vs omitted modality, and an omitted vs
 * `false` web-search flag all hash identically.
 */
export function startTurnBodyHash(
  body: z.infer<typeof startTurnBodySchema>,
  history: ChatHistoryMessage[]
): string {
  return hashRequestBody({
    conversationId: body.conversationId,
    turnSources: body.turnSources,
    ...(body.forkId === undefined ? {} : { forkId: body.forkId }),
    ...(body.webSearchEnabled === true ? { webSearchEnabled: true } : {}),
    ...(body.modality === 'text' ? {} : { modality: body.modality }),
    ...(body.imageConfig === undefined ? {} : { imageConfig: body.imageConfig }),
    ...(body.videoConfig === undefined ? {} : { videoConfig: body.videoConfig }),
    // Reasoning effort is client intent that changes the answer — scoped into
    // the dedup like the other optionals; omitted hashes identically to before.
    ...(body.reasoningEffort === undefined ? {} : { reasoningEffort: body.reasoningEffort }),
    // Custom instructions are client intent that changes the answer, so they
    // scope the dedup like history — omitted hashes identically to before.
    ...(body.customInstructions === undefined
      ? {}
      : { customInstructions: body.customInstructions }),
    userMessage: body.userMessage,
    history,
  });
}

/** The canonical dedup body for a regenerate turn (`regenerate` scopes the retry/edit intent). */
export function regenerateTurnBodyHash(
  body: z.infer<typeof regenerateTurnBodySchema>,
  history: ChatHistoryMessage[],
  regenerateCore: Readonly<Record<string, unknown>>
): string {
  return hashRequestBody({
    conversationId: body.conversationId,
    turnSources: body.turnSources,
    ...(body.forkId === undefined ? {} : { forkId: body.forkId }),
    ...(body.webSearchEnabled === true ? { webSearchEnabled: true } : {}),
    // A default `text` modality hashes identically to an omitted one, so an
    // older client's text regenerate never 409s against its own retry.
    ...(body.modality === 'text' ? {} : { modality: body.modality }),
    ...(body.imageConfig === undefined ? {} : { imageConfig: body.imageConfig }),
    ...(body.videoConfig === undefined ? {} : { videoConfig: body.videoConfig }),
    // Reasoning effort is client intent that changes the answer — scoped into
    // the dedup like the other optionals; omitted hashes identically to before.
    ...(body.reasoningEffort === undefined ? {} : { reasoningEffort: body.reasoningEffort }),
    ...(body.customInstructions === undefined
      ? {}
      : { customInstructions: body.customInstructions }),
    userMessage: body.userMessage,
    regenerate: regenerateCore,
    history,
  });
}
