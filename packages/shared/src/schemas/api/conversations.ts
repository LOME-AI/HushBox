import { z } from 'zod';
import { MemberPrivilege as memberPrivilegeSchema } from '../../enums/member-privilege.ts';
import {
  ReasoningEffortSelection,
  ResolvedReasoningEffort,
} from '../../affordability/reasoning-effort.ts';
import { contentTypeSchema } from './message-shares.ts';
import { smartSlotSelected, turnSourceListSchema } from './turn-sources.ts';
import { ChatHistoryMessage } from '../../workflow/inference.ts';
import { fromBase64 } from '../../utils/base64.ts';
import {
  AUDIO_FORMATS,
  MAX_AUDIO_DURATION_SECONDS,
  MAX_CONVERSATION_MEMBERS,
} from '../../constants.ts';
import type { TurnSourceList } from './turn-sources.ts';

/**
 * Request bodies for the conversation and chat surfaces. All ciphertext and key
 * material travels base64-encoded and stays opaque to the API; ids the client
 * supplies are validated as uuids but never trusted for identity — the caller is
 * always the server-resolved principal.
 *
 * These are the schemas the routes validate with, so a bound relaxed here
 * relaxes server-side validation. {@link startTurnBodySchema} and
 * {@link regenerateTurnBodySchema} carry a second coupling: their parsed output
 * is projected into the idempotency body hash, so a change in what they parse
 * moves the hash and 409s a client's own retry of a logically identical
 * request.
 */

/** Encoded-length caps bound payloads; decode is the real validity check. */
export function base64Field(maxLength: number): z.ZodType<string> {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => {
      try {
        fromBase64(value);
        return true;
      } catch {
        return false;
      }
    }, 'must be valid base64');
}

export const KEY_MATERIAL_MAX = 4096;
/**
 * Encoded cap on a title's ciphertext. Derived: a 512-byte plaintext title (an
 * order of magnitude past a few words) plus the wrap blob's 74-byte fixed
 * overhead is 784 base64 characters, rounded up. It bounds amplification —
 * every member downloads every title on every conversation-list read.
 */
const TITLE_MAX = 1024;
const FORK_NAME_MAX_LENGTH = 100;

export const createConversationBodySchema = z.object({
  /** Client-generated uuid: the natural idempotency key of the bootstrap. */
  id: z.uuid(),
  title: base64Field(TITLE_MAX).optional(),
  epochPublicKey: base64Field(KEY_MATERIAL_MAX),
  confirmationHash: base64Field(KEY_MATERIAL_MAX),
  /** The owner's ECIES wrap of the first epoch key. */
  memberWrap: base64Field(KEY_MATERIAL_MAX),
});

/**
 * `z.infer` and not `z.input`: `base64Field` is declared as `z.ZodType<string>`,
 * whose zod-v4 INPUT parameter defaults to `unknown`, so `z.input` would widen
 * every base64 field to `unknown` at the client. The schema carries no default,
 * so input and output describe the same JSON either way.
 */
export type CreateConversationRequest = z.infer<typeof createConversationBodySchema>;

/**
 * The owner's title update. `title` is opaque ciphertext (base64, decoded
 * in-domain, never inspected); `titleEpochNumber` is the epoch the client
 * encrypted the title under.
 */
export const updateTitleBodySchema = z.object({
  title: base64Field(TITLE_MAX),
  titleEpochNumber: z.number().int().min(1),
});

export type UpdateConversationRequest = z.infer<typeof updateTitleBodySchema>;

/**
 * The rotation carried by the routes that change the seat set. Its wrap set covers
 * every seat the conversation holds after the change, so it is bounded by the member cap.
 */
export const rotationBodySchema = z.object({
  expectedEpoch: z.number().int().min(1),
  epochPublicKey: base64Field(KEY_MATERIAL_MAX),
  confirmationHash: base64Field(KEY_MATERIAL_MAX),
  chainLink: base64Field(KEY_MATERIAL_MAX),
  memberWraps: z
    .array(
      z.object({
        memberPublicKey: base64Field(KEY_MATERIAL_MAX),
        wrap: base64Field(KEY_MATERIAL_MAX),
      })
    )
    .min(1)
    .max(MAX_CONVERSATION_MEMBERS),
  encryptedTitle: base64Field(TITLE_MAX),
});

export type StreamChatRotation = z.infer<typeof rotationBodySchema>;

/**
 * The standalone rotation. `predecessorEpoch` names the epoch the new chain link
 * opens to; absent, it is `expectedEpoch`. A recovery names an earlier epoch
 * whose keys verified, skipping the epochs whose keys did not.
 */
export const rotateEpochBodySchema = rotationBodySchema.extend({
  predecessorEpoch: z.number().int().min(1).optional(),
});

export type RotateEpochBody = z.infer<typeof rotateEpochBodySchema>;

/** A rotation that lost the expected-epoch race reports the epoch that won. */
export const rotateEpochOutcomeSchema = z.discriminatedUnion('rotated', [
  z.object({ rotated: z.literal(true), newEpochNumber: z.number().int().min(1) }),
  z.object({ rotated: z.literal(false), currentEpoch: z.number().int().min(1) }),
]);

export type RotateEpochOutcome = z.infer<typeof rotateEpochOutcomeSchema>;

export const createForkBodySchema = z.object({
  /** Client-generated uuid: the natural idempotency key of the fork. */
  id: z.uuid(),
  fromMessageId: z.uuid(),
  name: z.string().min(1).max(FORK_NAME_MAX_LENGTH).optional(),
});

export const renameForkBodySchema = z.object({
  name: z.string().min(1).max(FORK_NAME_MAX_LENGTH),
});

/**
 * Image generation config — SHAPE ONLY, deliberately. Which aspect ratios exist
 * is per model and lives in the catalog's own ParamSpecs; the turn builder
 * validates the request's media params against the selected models' declared
 * domains through the shared `compileParamSpec`, so a value this schema admits
 * and the model does not offer is still a 400 on the same request, before any
 * hold. Enumerating a global set here would be a second option domain, which is
 * exactly what the catalog replaced.
 */
export const imageConfigSchema = z.object({
  aspectRatio: z.string().min(1).default('1:1'),
});

export type ImageConfig = z.infer<typeof imageConfigSchema>;

/** Video generation config. Shape only, for the reason {@link imageConfigSchema} carries. */
export const videoConfigSchema = z.object({
  aspectRatio: z.string().min(1),
  durationSeconds: z.number().int().positive(),
  resolution: z.string().min(1),
});

export type VideoConfig = z.infer<typeof videoConfigSchema>;

/**
 * Audio (TTS) generation config. Unlike video, the duration of TTS output is
 * not user-controllable — it emerges from synthesizing the input text — so
 * `maxDurationSeconds` caps worst-case spend rather than fixing the duration.
 */
export const audioConfigSchema = z.object({
  format: z.enum(AUDIO_FORMATS).default('mp3'),
  voice: z.string().optional(),
  maxDurationSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_AUDIO_DURATION_SECONDS)
    .default(MAX_AUDIO_DURATION_SECONDS),
});

export type AudioConfig = z.infer<typeof audioConfigSchema>;

/**
 * Request schema for POST /chat/message.
 * Saves a user-only message without triggering AI. Free — no billing.
 * Used in group chats when the AI toggle is off.
 */
// Strict: the server mints the message id, so a body naming one is refused
// rather than silently ignored.
export const userOnlyMessageSchema = z.strictObject({
  content: z.string().min(1),
  // The branch being viewed when the message is sent. When present, the send
  // chains onto that fork's tip and advances it (mirroring a paid turn);
  // absent is a linear send onto the conversation's high-sequence tip.
  forkId: z.uuid().optional(),
});

export type UserOnlyMessageRequest = z.infer<typeof userOnlyMessageSchema>;

/**
 * Smart plus media generation is out by design, and it is refused HERE — in the
 * body shape both paid routes parse — rather than by a handler guard, so no
 * route has to remember it and no later guard deletion can reopen it.
 *
 * The slot names no model, and there is no media candidate derivation to give it
 * one, so a media body carrying it selects one generation fewer than the client
 * asked for: the run would compile the pinned models alone, silently dropping
 * the slot, and the client would hold a tile no stream ever reaches.
 */
function mediaModalityCarriesNoSmartSlot(data: {
  readonly modality: 'text' | 'image' | 'video';
  readonly turnSources: TurnSourceList;
}): boolean {
  return data.modality === 'text' || !smartSlotSelected(data.turnSources);
}

/**
 * The user message a turn body carries: content only. Strict, so a body still
 * naming an id is refused at validation rather than having it stripped.
 */
const turnUserMessageSchema = z.strictObject({
  content: z.string().min(1),
});

export const startTurnBodySchema = z
  .object({
    conversationId: z.string().min(1),
    // The answer sources this turn is sent to, in the client's selected order —
    // one entry per answer. A `model` source is pinned by name; the `smart`
    // source is the classifier-resolved slot, which names no model.
    turnSources: turnSourceListSchema,
    // The output modality of the turn. `text` (the default) is the model+multi-
    // model chat turn; `image`/`video` is a single-model media generation whose
    // `modelCall` produces that modality and carries the config below as params.
    modality: z.enum(['text', 'image', 'video']).default('text'),
    // The branch this turn extends. Absent for a linear send; when present the
    // turn chains onto the fork's tip and advances it at settlement.
    forkId: z.uuid().optional(),
    // Opt into server-side web search on the answer: the turn's modelCall carries
    // the web-search tool loop. Requires a tool-capable model (refused at build
    // otherwise). Absent/false is a plain turn.
    webSearchEnabled: z.boolean().optional(),
    // Reasoning effort for a TEXT turn: a canonical ladder label, `auto` (the
    // server picks), or `none` (the explicit hard-off wire). Resolved against
    // the model through the shared reasoning plan at build — an unoffered
    // label, a non-reasoning model, or `none` on a mandatory-reasoning model
    // refuses with 400, never a silent downgrade. Absent = today's turn,
    // unchanged.
    reasoningEffort: ReasoningEffortSelection.optional(),
    // Generation config for a media turn (reused from the conversations schema,
    // with its refinements). `image` may omit it (aspectRatio defaults); `video`
    // must supply it (see the refinement below).
    imageConfig: imageConfigSchema.optional(),
    videoConfig: videoConfigSchema.optional(),
    // The initiator's message: its content (the prompt). The server mints the id
    // the turn's user row is stored under; a body naming one is refused.
    userMessage: turnUserMessageSchema,
    // Prior turns, resent by the client every send (E2E crypto: the server
    // cannot reconstruct them). Deliberately unbounded — no count or length cap.
    history: z.array(ChatHistoryMessage).optional(),
    // The user's custom instructions, decrypted client-side and resent each turn
    // (stored E2E-encrypted, like history) so they reach the model as plaintext.
    // Folded into the base system prompt; bounded to match InferenceRequest.
    customInstructions: z.string().max(5000).optional(),
  })
  .refine((data) => data.modality !== 'video' || data.videoConfig !== undefined, {
    message: 'videoConfig is required when modality is "video"',
    path: ['videoConfig'],
  })
  .refine(mediaModalityCarriesNoSmartSlot, {
    message: 'the Smart slot cannot answer a media turn',
    path: ['turnSources'],
  });

export const regenerateTurnBodySchema = z
  .object({
    conversationId: z.string().min(1),
    // The re-run's answer sources, in selected order — the same vocabulary the
    // send routes carry, so send and regenerate resolve one shape.
    turnSources: turnSourceListSchema,
    // The regenerated turn's output modality, symmetric with `/chat`: `text`
    // (the default, so existing clients are unchanged) re-runs the text turn;
    // `image`/`video` re-runs a single-model or fan-out media generation over
    // the same anchor (the per-tile media retry). Audio is deferred.
    modality: z.enum(['text', 'image', 'video']).default('text'),
    // The anchor USER message this turn re-runs. `action` keeps it (`retry`,
    // swapping the reply) or replaces it (`edit`); `replaceAssistantId` (retry
    // only, enforced by the refinement below) deletes just that reply instead of
    // every reply below the anchor.
    targetMessageId: z.uuid(),
    action: z.enum(['retry', 'edit']),
    replaceAssistantId: z.uuid().optional(),
    // The branch the target lives on; absent for a linear conversation.
    forkId: z.uuid().optional(),
    // Opt into server-side web search on the answer: the turn's modelCall carries
    // the web-search tool loop. Requires a tool-capable model (refused at build
    // otherwise). Absent/false is a plain turn. Symmetric with `/chat` so a
    // regenerated search-backed answer can stay a search answer.
    webSearchEnabled: z.boolean().optional(),
    // Reasoning effort for a TEXT regenerate, symmetric with `/chat` (the same
    // resolver validates it): a canonical ladder label, `auto`, or `none`.
    // Refused, or honoured, exactly as a send is — never silently downgraded.
    // Absent hashes the pre-feature shape, so an old client's retry never 409s.
    reasoningEffort: ReasoningEffortSelection.optional(),
    // Generation config for a media regenerate (the same shared schemas the
    // send path validates with). `image` may omit it (aspectRatio defaults);
    // `video` must supply it (see the refinement below, mirroring `/chat`).
    imageConfig: imageConfigSchema.optional(),
    videoConfig: videoConfigSchema.optional(),
    // The turn's user message: for `edit`, the replacement's edited content; for
    // `retry`, the re-sent prompt (content feeds inference). No id, as for `/chat`.
    userMessage: turnUserMessageSchema,
    // Prior turns up to the anchor, resent by the client exactly like a send.
    history: z.array(ChatHistoryMessage).optional(),
    // The user's custom instructions, decrypted client-side and resent each turn;
    // folded into the base system prompt. Bounded to match InferenceRequest.
    customInstructions: z.string().max(5000).optional(),
  })
  .refine((data) => data.modality !== 'video' || data.videoConfig !== undefined, {
    message: 'videoConfig is required when modality is "video"',
    path: ['videoConfig'],
  })
  .refine(mediaModalityCarriesNoSmartSlot, {
    message: 'the Smart slot cannot answer a media turn',
    path: ['turnSources'],
  })
  // An edit's delete is bounded by the anchor, not by a named reply, and never
  // reads `replaceAssistantId`, so a body carrying both names two different
  // deletes. Refusing it here is what makes the pre-run guard's retry-one arm
  // provably the settlement's: both discriminate on `action` before the reply id.
  .refine((data) => data.action === 'retry' || data.replaceAssistantId === undefined, {
    message: 'replaceAssistantId belongs to a retry, not an edit',
    path: ['replaceAssistantId'],
  });

export const stopTurnBodySchema = z.object({
  conversationId: z.string().min(1),
});

export const trialTurnBodySchema = z.object({
  // The same ordered vocabulary the paid routes carry, bounded to ONE answer:
  // a trial turn has no fan-out builder and never will, so a second source is
  // refused by the shape rather than by a runtime check.
  turnSources: turnSourceListSchema.max(1),
  prompt: z.string().min(1),
  webSearchEnabled: z.boolean().optional(),
  // Reasoning effort for the trial answer. The route accepts only levels
  // whose shared-plan token cost fits the fixed trial ceiling — a costlier
  // one refuses with the trial's over-cap 402, and a level the model does
  // not offer at all with a typed 400.
  reasoningEffort: ReasoningEffortSelection.optional(),
  // Prior trial turns, client-held (trial persists nothing server-side).
  history: z.array(ChatHistoryMessage).optional(),
});

/**
 * A paid turn's run start (201): the run, its deadline, the id the turn's user
 * message is stored under, and one id per answer in the selected order, which
 * settlement stores each answer under, so a live tile and its stored row carry
 * one id. The route builds this body against it and the client parses with it.
 */
export const runStartedResponseSchema = z.object({
  runId: z.string().min(1),
  deadlineAt: z.number().int(),
  userMessageId: z.string().min(1),
  assistantMessageIds: z.array(z.string().min(1)).min(1),
});

export type RunStartedResponse = z.infer<typeof runStartedResponseSchema>;

/**
 * A resend of a run still live in the room (200): the client rejoins its stream.
 * The ids name the live run's messages, or are null when no run under the key is
 * live. A trial run stores no answers, so it names an empty list.
 */
export const runAttachResponseSchema = z.object({
  outcome: z.literal('attach'),
  userMessageId: z.string().min(1).nullable(),
  assistantMessageIds: z.array(z.string().min(1)).nullable(),
});

export type RunAttachResponse = z.infer<typeof runAttachResponseSchema>;

// ============================================================
// Response Schemas - Single Source of Truth for API responses
// ============================================================

/**
 * Schema for a conversation entity in API responses.
 * Title is base64-encoded encrypted bytea.
 * Includes epoch management fields.
 */
export const conversationResponseSchema = z.object({
  id: z.string(),
  title: z.string(), // base64-encoded encrypted title
  currentEpoch: z.number().int().min(1),
  titleEpochNumber: z.number().int().min(1),
  nextSequence: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ConversationResponse = z.infer<typeof conversationResponseSchema>;

/**
 * The caller's read cursor: the highest message sequence they have acknowledged
 * in this conversation. Zero means nothing read (sequences start at one), which
 * is also the safe default for a payload that predates the field.
 */
const lastReadSeqSchema = z.number().int().nonnegative().default(0);

/**
 * Schema for a conversation list item in GET /conversations responses.
 * Extends base conversation with membership acceptance state.
 *
 * `muted` and `pinned` are intentionally list-only — they are per-user display
 * preferences relevant when scanning conversations, not needed in the
 * single-conversation detail response (conversationResponseSchema).
 */
export const conversationListItemSchema = conversationResponseSchema.extend({
  accepted: z.boolean(),
  invitedByUsername: z.string().nullable(),
  privilege: memberPrivilegeSchema,
  muted: z.boolean().default(false),
  pinned: z.boolean().default(false),
  lastReadSeq: lastReadSeqSchema,
  /**
   * Seats not left, users and link guests alike: the rows the member list
   * shows. At least one, because the caller's own seat is among them.
   */
  memberCount: z.number().int().positive(),
});

export type ConversationListItem = z.infer<typeof conversationListItemSchema>;

/**
 * A content item as both message reads serve it — the member history read and
 * the unauthenticated public standalone-message share. Text items carry
 * `encryptedBlob` (base64) inline; media items carry `encryptedBlob: null` and
 * are fetched by presigning `id` (the content-item id) through the media slice,
 * which is why no storage key appears on the wire. Fields that do not apply to
 * a given `contentType` are null.
 */
export const contentItemResponseSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  contentType: contentTypeSchema,
  mimeType: z.string().nullable(),
  byteLength: z.number().int().nullable(),
  /** Pixel width of a media item (null for text/audio) — the client's aspect-ratio source. */
  width: z.number().int().nullable(),
  /** Pixel height of a media item (null for text/audio) — the client's aspect-ratio source. */
  height: z.number().int().nullable(),
  /** Duration of time-based media (video/audio) in milliseconds, or null. */
  durationMs: z.number().int().nullable(),
  /** Base64 symmetric ciphertext under the parent message's content key; null for media. */
  encryptedBlob: z.string().nullable(),
});

export type ContentItemResponse = z.infer<typeof contentItemResponseSchema>;

/**
 * The reasoning display fields, declared once because the member history read
 * and the public standalone-message share must serve the same values for the
 * same content item; a second declaration could drift from this one.
 */
const reasoningDisplayFields = {
  /**
   * Persisted reasoning-token count for the generation(s) anchored to this item
   * (from `llm_completions`), or null when none was recorded. Drives the
   * settled thinking label.
   */
  reasoningTokens: z.number().int().nullable(),
  /**
   * The level the generation behind this item reasoned at, or null when none
   * was recorded. It qualifies the settled reasoning row's label
   * (`apps/web/src/components/chat/message/thinking-disclosure.tsx`); null
   * leaves that label unqualified. Deliberate disclosure: this field is served
   * on the unauthenticated share read as well as the member history read, so a
   * share link publishes the rung its author's turn ran at. Nothing outside
   * that row surfaces it, so an item rendering no reasoning row publishes no
   * level however this is populated.
   */
  reasoningEffort: ResolvedReasoningEffort.nullable(),
  /**
   * How long the generation(s) behind this item showed reasoning, in whole
   * milliseconds, or null when none was recorded: replies settled before it was
   * measured, and models that bill reasoning without showing it.
   */
  reasoningDurationMs: z.number().int().nonnegative().nullable(),
};

/**
 * The model display fields, declared once for the same reason as
 * {@link reasoningDisplayFields}: the history read and the public share read
 * serve the same generating model and smart-model flag for the same item.
 * Deliberate disclosure: a share link publishes which model wrote the reply.
 */
const modelDisplayFields = {
  /** The generating model id, or null for user/system items. */
  modelName: z.string().nullable(),
  isSmartModel: z.boolean(),
};

/**
 * The history read's content item: {@link contentItemResponseSchema} plus the
 * settled display metadata (model, billed cost, token counts, smart-model flag,
 * reasoning). The billed cost and the input and output token counts live only
 * on this extension, so the public share read cannot serve them — widening the
 * base would leak a conversation's spend to an unauthenticated visitor, and the
 * token counts times the model's public rates rebuild that spend.
 */
export const historyContentItemResponseSchema = contentItemResponseSchema.extend({
  ...modelDisplayFields,
  /** Total billed cost anchored to this item as a canonical NanoUSD string, or null. */
  cost: z.string().nullable(),
  /**
   * Input tokens summed over the completions anchored to this item, or null
   * when none was recorded or the caller is a link guest.
   */
  inputTokens: z.number().int().nullable(),
  /**
   * Output tokens summed over the completions anchored to this item, or null
   * when none was recorded or the caller is a link guest.
   */
  outputTokens: z.number().int().nullable(),
  ...reasoningDisplayFields,
});

export type HistoryContentItemResponse = z.infer<typeof historyContentItemResponseSchema>;

/**
 * The public standalone-message share's content item: {@link contentItemResponseSchema}
 * plus {@link modelDisplayFields} and {@link reasoningDisplayFields}, so a shared
 * reply names its model and reads its reasoning exactly as its author's does.
 * Carrying the model, the flag, the rung and the token count to an
 * unauthenticated visitor is a deliberate disclosure decision; the billed cost
 * stays on the history read.
 */
export const sharedContentItemResponseSchema = contentItemResponseSchema.extend({
  ...modelDisplayFields,
  ...reasoningDisplayFields,
});

export type SharedContentItemResponse = z.infer<typeof sharedContentItemResponseSchema>;

/**
 * One message of the member history read, `GET /conversations/:id/messages`.
 *
 * Under the wrap-once envelope model, each message has one `wrappedContentKey`
 * (ECIES-wrapped under the epoch public key) plus one or more `contentItems`
 * encrypted symmetrically under the unwrapped content key. Clients unwrap the
 * content key once and decrypt every content item with it.
 *
 * There is deliberately no `conversationId` (the client holds it as the route
 * param it paged by). Message order comes from `sequenceNumber`, never from
 * `createdAt`.
 *
 * `senderType` is the database enum verbatim. `parentMessageId` is served
 * unfiltered even when it names a message below the caller's epoch floor: the
 * floor decides which rows a caller reads, never which identifiers a row
 * carries, and holding such an id confers nothing.
 */
export const messageResponseSchema = z.object({
  id: z.string(),
  parentMessageId: z.string().nullable(),
  sequenceNumber: z.number().int(),
  epochNumber: z.number().int(),
  senderType: z.enum(['user', 'assistant', 'system']),
  senderId: z.string().nullable(),
  /** Base64-encoded ECIES-wrapped content key for this message. */
  wrappedContentKey: z.string(),
  /**
   * Per-turn id shared by all messages persisted in one `saveChatTurn`.
   * Drives the multi-model-peer vs fork-preserve-orphan distinction in
   * the client-side fork-filter.
   */
  batchId: z.string(),
  /**
   * True once the sender's account deletion erased this message's content; its
   * `contentItems` is then empty. The deletion instant is deliberately not served.
   */
  deleted: z.boolean(),
  /** When the message was created, as an ISO string. */
  createdAt: z.iso.datetime(),
  /** Discrete content items belonging to this message, ordered by position. */
  contentItems: z.array(historyContentItemResponseSchema),
});

export type MessageResponse = z.infer<typeof messageResponseSchema>;

/**
 * The unauthenticated public standalone-message share, `GET /shares/m/:shareId`.
 * A different endpoint from the history read with a different payload, not a
 * variant of it: it carries the share row's own id and the AAD inputs a visitor
 * needs to open the blobs, and it carries no `senderType`.
 *
 * `epochWrappedContentKey` is ciphertext to the epoch public key, so publishing
 * it beside a share discloses nothing the share does not already grant.
 */
export const sharedMessageResponseSchema = z.object({
  /** The `shared_messages` row id — the client mints media presign URLs with it. */
  shareId: z.string(),
  messageId: z.string(),
  /** The content key wrapped under the share secret; the URL fragment opens it. */
  wrappedContentKey: z.string(),
  /** When the share was created. */
  createdAt: z.string(),
  /** When the shared message itself was created. */
  messageCreatedAt: z.string(),
  conversationId: z.string(),
  epochNumber: z.number().int(),
  senderId: z.string().nullable(),
  epochWrappedContentKey: z.string(),
  /** True once the sender's account deletion erased the message's content; never its instant. */
  deleted: z.boolean(),
  contentItems: z.array(sharedContentItemResponseSchema),
});

export type SharedMessageResponse = z.infer<typeof sharedMessageResponseSchema>;

/**
 * Schema for a fork entity in API responses. The fork's `conversationId` is
 * deliberately absent: the client already holds it as the parent route param.
 */
export const forkResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  tipMessageId: z.string().nullable(),
  createdAt: z.string(),
});

export type ForkResponse = z.infer<typeof forkResponseSchema>;

/**
 * The single source of truth for the key-chain wire contract — the crypto
 * material the client needs to unwrap and verify a conversation's epoch keys.
 * Served by `GET /:conversationId/keychain` (one conversation) and
 * `GET /member-keys/batch` (many). No request path parses these schemas: the
 * server's `serializeKeyChain` and the client's `processKeyChain` annotate
 * against the inferred types, so it is TypeScript's structural check, not Zod,
 * that turns a field rename here into a compile error at both ends.
 *
 * All ciphertext/hash/key fields are base64. There is deliberately no
 * `visibleFromEpoch` here: it is a server-side membership-floor filter applied
 * while assembling the chain, never consumed by the client.
 */

/**
 * One epoch at or above the caller's floor. `previousEpochNumber` is the epoch
 * this one's chain link opens to, which a recovery rotation makes lower than
 * `epochNumber - 1`, so a client follows it and never assumes the epoch below.
 * `chainLink` is null when there is no predecessor, and when the predecessor is
 * below the floor: traversing that link would yield a pre-membership key.
 */
export const keyChainEpochSchema = z.object({
  epochNumber: z.number().int().min(1),
  epochPublicKey: z.string(),
  confirmationHash: z.string(),
  previousEpochNumber: z.number().int().min(1).nullable(),
  chainLink: z.string().nullable(),
});

export type KeyChainEpoch = z.infer<typeof keyChainEpochSchema>;

export const keyChainWrapSchema = z.object({
  epochNumber: z.number().int().min(1),
  wrap: z.string(), // base64 ECIES-wrapped epoch key
});

export type KeyChainWrap = z.infer<typeof keyChainWrapSchema>;

/**
 * `rotationPending` is derived at read time: the current epoch still holds a
 * wrap for a seat that is no longer live, so the next encryption waits for a
 * rotation.
 */
export const keyChainResponseSchema = z.object({
  epochs: z.array(keyChainEpochSchema),
  wraps: z.array(keyChainWrapSchema),
  currentEpoch: z.number().int().min(1),
  rotationPending: z.boolean(),
});

export type KeyChainResponse = z.infer<typeof keyChainResponseSchema>;

/**
 * Response schema for GET /conversations
 */
export const listConversationsResponseSchema = z.object({
  conversations: z.array(conversationListItemSchema),
  nextCursor: z.string().nullable(),
});

export type ListConversationsResponse = z.infer<typeof listConversationsResponseSchema>;

/**
 * The requesting caller's membership facts for a single conversation.
 * `visibleFromEpoch` is the caller's epoch floor; `muted`/`pinned` are
 * per-user display preferences. `linkId` names the share link a guest caller
 * joined through and is null for a signed-in member: a guest has no account
 * id, so the link it joined through is what says which member row is the
 * caller's here. It is the same identity a guest carries as a message
 * `senderId` and as its realtime principal.
 */
export const membershipViewSchema = z.object({
  privilege: memberPrivilegeSchema,
  muted: z.boolean(),
  pinned: z.boolean(),
  accepted: z.boolean(),
  visibleFromEpoch: z.number().int().min(1),
  lastReadSeq: lastReadSeqSchema,
  linkId: z.string().nullable(),
});

export type MembershipView = z.infer<typeof membershipViewSchema>;

/**
 * Response schema for GET /conversations/:id: the conversation record, the
 * caller's `membership`, and the conversation's forks. Message history is
 * served separately by GET /conversations/:id/messages, so it is not embedded
 * here.
 */
export const getConversationResponseSchema = z.object({
  conversation: conversationResponseSchema,
  membership: membershipViewSchema,
  forks: z.array(forkResponseSchema).default([]),
});

export type GetConversationResponse = z.infer<typeof getConversationResponseSchema>;

/**
 * Response schema for POST /conversations. `created` is:
 * - true  = a newly created conversation (its first turn should be streamed)
 * - false = idempotent return of an already-existing conversation (no re-stream)
 */
export const createConversationResponseSchema = z.object({
  conversation: conversationResponseSchema,
  created: z.boolean(),
});

export type CreateConversationResponse = z.infer<typeof createConversationResponseSchema>;

/**
 * Response schema for PATCH /conversations/:id
 */
export const updateConversationResponseSchema = z.object({
  conversation: conversationResponseSchema,
});

export type UpdateConversationResponse = z.infer<typeof updateConversationResponseSchema>;

/**
 * Response schema for DELETE /conversations/:id
 */
export const deleteConversationResponseSchema = z.object({
  deleted: z.boolean(),
});

export type DeleteConversationResponse = z.infer<typeof deleteConversationResponseSchema>;
