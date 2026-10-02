import { z } from 'zod';
import { NanoUSD } from '@hushbox/shared';

export const conversationBodySchema = z.object({
  ownerEmail: z.email(),
  // Optional plaintext title, encrypted to the epoch by the seed factory; lets a
  // caller give the seeded conversation a stable, human-tappable chat-row label
  // (empty ⇒ the untitled placeholder). Ignored on the multi-model path.
  title: z.string().optional(),
  messages: z
    .array(z.object({ content: z.string(), senderType: z.enum(['user', 'ai']) }))
    .optional(),
  // Multi-model fan-out seed: one user prompt with `responseCount` sibling
  // AI tiles; when present it takes the multi-model path.
  aiTurn: z.object({ userContent: z.string(), responseCount: z.number().int().min(1) }).optional(),
});

export const groupChatBodySchema = z.object({
  ownerEmail: z.email(),
  memberEmails: z.array(z.email()),
  pendingMemberEmails: z.array(z.email()).optional(),
  messages: z
    .array(
      z.object({
        senderEmail: z.email().optional(),
        content: z.string(),
        senderType: z.enum(['user', 'ai']),
      })
    )
    .optional(),
});

/**
 * Backdated usage records for a billing-surface precondition. Text-only: the
 * per-model usage read inner-joins `llm_completions`, so a record carrying no
 * token dimension would be written and then invisible to the surface this
 * exists to prepare.
 */
export const usageHistoryBodySchema = z.object({
  ownerEmail: z.email(),
  conversationId: z.uuid(),
  records: z
    .array(
      z.object({
        modelId: z.string().min(1),
        providerName: z.string().min(1),
        costNanoUsd: NanoUSD,
        inputTokens: z.number().int().min(0),
        outputTokens: z.number().int().min(0),
        createdAt: z.iso.datetime(),
      })
    )
    .min(1),
});

/**
 * The accounts an auth-rate-limit reset is asked to clear. Emails and usernames
 * both, in whatever case the caller has them; the route canonicalizes each the
 * way the limiters key it and resolves the account it names, if any.
 *
 * Required, and legitimately empty: an empty list asks for the caller's own
 * per-IP windows and nothing else, which is what a suite wants when the
 * accounts it is about to exercise do not exist yet. What it can no longer ask
 * for is every account in the environment.
 */
export const authRateLimitsBodySchema = z.object({
  identifiers: z.array(z.string().min(1)).max(20),
});
