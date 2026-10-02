import { z } from 'zod';

import { FEEDBACK_STATUSES } from '../enums/feedback.ts';
import { NanoUSD } from '../affordability/money/nano-usd.ts';
import {
  BANNER_VARIANTS,
  MAX_BANNER_LINK_TEXT_LENGTH,
  MAX_BANNER_MESSAGES,
  MAX_BANNER_TEXT_LENGTH,
} from '../schemas/api/announcements.ts';
import { campaignLabelSchema } from '../growth/campaign-label.ts';
import { GROWTH_GRAIN } from '../growth/enums.ts';
import { BUCKET_MAXIMUM_NOTE } from '../growth/funnel-steps.ts';
import { campaignTagSchema, GROWTH_PATH_MAX_LENGTH } from '../growth/patterns.ts';
import { defineAdminOpContract } from './contract.ts';

/**
 * Cap on a single admin wallet credit/clawback: $1,000 in nano-USD.
 * Guardrail data — bounds the blast radius of a compromised-but-valid admin
 * session; larger corrections run as multiple audited ops.
 */
export const ADMIN_WALLET_ADJUSTMENT_CAP_NANO_USD = 1_000_000_000_000n;

/**
 * Single source for the `user_lock_reason` value set — packages/db derives
 * its pgEnum from this const (the shared-const-feeds-pgEnum pattern).
 * `user.lock`'s input carries the reason so `user.unlock`'s undo can restore
 * the original value (inverse snapshot semantics), never a default.
 */
export const USER_LOCK_REASONS = ['chargeback', 'admin'] as const;

/**
 * Cap on the required `reason` justification: it lands verbatim in the
 * append-only `admin_audit` jsonb, so an unbounded string would be permanent
 * storage abuse. Generous for a sentence; anything longer belongs elsewhere.
 */
export const MAX_ADMIN_REASON_LENGTH = 1000;

/**
 * Cap on an operator-supplied model id. The id is an OpenRouter slug
 * (`vendor/model-name:variant`); the longest one in the live catalog is under
 * 40 characters, so this is headroom rather than a product limit.
 */
export const MAX_ADMIN_MODEL_ID_LENGTH = 200;

/**
 * Cap on a newsletter subject. It becomes an email `Subject:` header, which
 * RFC 5322 bounds at 998 octets per line and every mail client truncates on
 * screen long before that.
 */
export const MAX_ADMIN_NEWSLETTER_SUBJECT_LENGTH = 200;

/**
 * Cap on a newsletter body, and so the longest issue that can ever be
 * scheduled through this path: roughly 8,000 words. Markdown grows when it is
 * rendered to HTML, and Gmail clips a message past ~102 KB, so a body at this
 * cap still arrives whole.
 */
export const MAX_ADMIN_NEWSLETTER_BODY_LENGTH = 50_000;

/**
 * Cap on how many retired TOTP key ids one stranded-restore may name. A group
 * is one retired key, and the rotation runbook retires one key per rotation,
 * so this is headroom rather than a product limit — and it bounds what a
 * recorded inverse input can put in the append-only `admin_audit` jsonb.
 */
export const MAX_STRANDED_TOTP_GROUPS = 20;

/**
 * Cap on a TOTP key id as the wire carries it: lowercase hex, an even number
 * of digits. The exact width is the crypto package's `FINGERPRINT_BYTES`,
 * which this package cannot import (crypto depends on shared, not the other
 * way), and is deliberately not restated here — a restated width would be a
 * second source of truth for it. A key id of the wrong width names no rows,
 * so the door's count check refuses it; this bound only keeps an unbounded
 * string out of the audit row.
 */
export const MAX_TOTP_KEY_ID_HEX_LENGTH = 64;

/**
 * Cap on an operator-typed SQL panel query. The query is audited verbatim
 * before it executes, so the same permanent-storage bound that shapes `reason`
 * applies; roomy for a multi-CTE investigation, far under the request-body
 * ceiling that would otherwise be the only limit.
 */
export const MAX_ADMIN_SQL_QUERY_LENGTH = 10_000;

/**
 * Cap on an operator-supplied provider transaction id. It lands verbatim in
 * the append-only `admin_audit` jsonb and on the payment row itself, so the
 * same permanent-storage bound that shapes `reason` applies; Helcim's own ids
 * are short, so this is headroom rather than a product limit.
 */
export const MAX_ADMIN_TRANSACTION_ID_LENGTH = 100;

/**
 * How many hourly event rows one page of the named-events read carries. The
 * read's window is operator-chosen, so without a page the response would grow
 * with the window rather than with the screen.
 */
export const GROWTH_EVENTS_PAGE_SIZE = 200;

/**
 * The widest window any growth read may ask for, in days. Growth rows are kept
 * forever, so an unbounded window is an unbounded response; a little over a
 * year covers every cohort comparison the dashboard draws.
 *
 * It bounds memory as well as bytes: `growth.sources.read` and
 * `growth.events.read` fetch every row the window matches and reduce it inside
 * the Worker — one counting a row-per-account view, the other slicing out a
 * single page — so what the Worker holds tracks the window, not the response.
 * Widening the cap is safe only once those two group and page in the database.
 */
export const MAX_GROWTH_READ_WINDOW_DAYS = 400;

/**
 * Operator-typed text, bounded then trimmed. Check order is load-bearing: the
 * engine audits the raw wire value, not the parsed one, so a cap applied after
 * `.trim()` bounds nothing — whitespace padding walks straight past it into the
 * append-only `admin_audit` row. `.min(1)` runs last so a whitespace-only value
 * is still rejected.
 */
function boundedOperatorText(maxLength: number): z.ZodString {
  return z.string().max(maxLength).trim().min(1);
}

const reason = boundedOperatorText(MAX_ADMIN_REASON_LENGTH);

/** Positive money amount at the JSON boundary: NanoUSD wire string → bigint. */
const positiveNanoUsd = NanoUSD.refine((value) => value > 0n, {
  message: 'amount must be positive',
});

const walletAdjustmentInput = z.object({
  walletId: z.uuid(),
  amountNanoUsd: positiveNanoUsd,
  reason,
});

const userTargetInput = z.object({ userId: z.uuid(), reason });
const jobTargetInput = z.object({ jobId: z.uuid(), reason });
const modelTargetInput = z.object({
  modelId: z.string().min(1).max(MAX_ADMIN_MODEL_ID_LENGTH),
  reason,
});
const shareTargetInput = z.object({ linkId: z.uuid(), reason });
/** Shared by the money pair, so their inputs are one type. */
const paymentTargetInput = z.object({ paymentId: z.uuid(), reason });

/**
 * The money-free pair's input: the payment, plus the provider transaction id
 * this run moves onto or off the row. Supplying it is the whole of the
 * operator's new knowledge, and one field carries both directions because the
 * pair round-trips through it — a restore ATTACHES the id to a row the verify
 * job expired without one, and the force-expire that undoes such a restore
 * DETACHES exactly that id. Omitted, both ops leave the column as they found
 * it. The id is never overwritten: each direction is guarded on the side the
 * column is currently on.
 */
const paymentHandleInput = z.object({
  paymentId: z.uuid(),
  helcimTransactionId: boundedOperatorText(MAX_ADMIN_TRANSACTION_ID_LENGTH).optional(),
  reason,
});

const newsletterSubject = boundedOperatorText(MAX_ADMIN_NEWSLETTER_SUBJECT_LENGTH);
const newsletterBody = z.string().min(1).max(MAX_ADMIN_NEWSLETTER_BODY_LENGTH);

/** A retired TOTP key id, lowercase hex, as the audit row records it. */
const totpKeyIdHex = z
  .string()
  .max(MAX_TOTP_KEY_ID_HEX_LENGTH)
  .regex(/^(?:[0-9a-f]{2})+$/, { message: 'key id must be lowercase hex' });

/**
 * One retired TOTP key id and how many second factors a recorded clear
 * disabled under it — the whole referee the bulk inverse runs on, so no user
 * id ever reaches the audit row. `count` is a recorded group's count, which
 * the door never records as zero, so a zero here could only be operator-typed
 * and is refused at the boundary.
 */
const strandedTotpGroup = z.object({
  fingerprint: totpKeyIdHex,
  count: z.number().int().positive(),
});

/**
 * The optional scope of a stranded clear: which retired keys it may reach.
 * Absent means every retired key — the sweep. A present list is non-empty, so
 * absence stays the only way to ask for the sweep and no value carries a
 * second meaning by being empty.
 */
const strandedTotpKey = z.object({ fingerprint: totpKeyIdHex });

const WALLET_GUARDRAILS = { maxAmountNanoUsd: ADMIN_WALLET_ADJUSTMENT_CAP_NANO_USD } as const;

/**
 * Admin banner links must be absolute http(s) URLs. Deliberately stricter
 * than the public banner salvage path (which also admits relative paths and
 * silently strips bad links): admin input REJECTS javascript:/data:/
 * protocol-relative targets instead of coercing them.
 */
function isSafeAbsoluteHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Strict admin counterpart to the salvaging public `bannerMessageSchema` —
 * bad variants and unsafe hrefs are rejected here, never coerced.
 */
const bannerMessageInput = z.object({
  variant: z.enum(BANNER_VARIANTS),
  text: boundedOperatorText(MAX_BANNER_TEXT_LENGTH),
  href: z
    .string()
    // Admin-side cap only — the public salvage path stays unbounded.
    .max(2048)
    .refine(isSafeAbsoluteHttpUrl, { message: 'href must be an absolute http(s) URL' })
    .optional(),
  linkText: boundedOperatorText(MAX_BANNER_LINK_TEXT_LENGTH).optional(),
});

/**
 * Every growth read's window, half-open `[from, to)` so consecutive windows
 * neither overlap nor drop a bucket. Its width is bounded in the op body
 * rather than here: a cross-field rule would make the input something other
 * than a plain object, and the generic form renderer reads `.shape`.
 */
const growthWindowInput = { from: z.iso.datetime(), to: z.iso.datetime() } as const;

/** A page path as the growth tables store one, for the named-events filter. */
const growthPathFilter = z.string().max(GROWTH_PATH_MAX_LENGTH);

/**
 * The v1 admin op inventory; contract facts are normative in the admin
 * slice's CLAUDE.md. Contracts only — implementations live in the admin
 * slice, whose engine validates each run against the contract it binds and
 * refuses it over that contract's guardrail cap; `adminOpCatalogEntry`
 * projects these onto `GET /admin/ops`, and the admin SPA builds the form of
 * every op it bundles from them. That GUI is the only production admin
 * surface, so nothing command-line renders them (CODE-RULES §Single Auth
 * Path Law).
 */
export const ADMIN_OP_CONTRACTS = {
  'wallet.credit': defineAdminOpContract({
    name: 'wallet.credit',
    title: 'Credit wallet',
    kind: 'mutation',
    input: walletAdjustmentInput,
    inverse: 'wallet.clawback',
    effectClass: 'durable',
    target: { type: 'wallet', field: 'walletId' },
    allowedRoles: ['operator'],
    guardrails: WALLET_GUARDRAILS,
  }),
  'wallet.clawback': defineAdminOpContract({
    name: 'wallet.clawback',
    title: 'Claw back wallet credit',
    kind: 'mutation',
    input: walletAdjustmentInput,
    inverse: 'wallet.credit',
    effectClass: 'durable',
    target: { type: 'wallet', field: 'walletId' },
    allowedRoles: ['operator'],
    guardrails: WALLET_GUARDRAILS,
  }),
  'user.lock': defineAdminOpContract({
    name: 'user.lock',
    title: 'Lock account',
    kind: 'mutation',
    input: z.object({ userId: z.uuid(), lockReason: z.enum(USER_LOCK_REASONS), reason }),
    inverse: 'user.unlock',
    effectClass: 'durable',
    target: { type: 'user', field: 'userId' },
    allowedRoles: ['operator'],
  }),
  'user.unlock': defineAdminOpContract({
    name: 'user.unlock',
    title: 'Unlock account',
    kind: 'mutation',
    input: userTargetInput,
    inverse: 'user.lock',
    effectClass: 'durable',
    target: { type: 'user', field: 'userId' },
    allowedRoles: ['operator'],
  }),
  'sessions.revokeAll': defineAdminOpContract({
    name: 'sessions.revokeAll',
    title: 'Revoke all sessions',
    kind: 'mutation',
    input: userTargetInput,
    inverse: null,
    effectClass: 'system-owned',
    systemOwnedReason:
      'the revocation cutoff is a durable job the session layer owes itself; the sessions it ' +
      'ends are recreated by the user logging in again, and an inverse restoring revoked ' +
      'sessions would be a security hole',
    target: { type: 'user', field: 'userId' },
    allowedRoles: ['operator'],
  }),
  'job.redrive': defineAdminOpContract({
    name: 'job.redrive',
    title: 'Redrive dead job',
    kind: 'mutation',
    input: jobTargetInput,
    inverse: null,
    effectClass: 'system-owned',
    systemOwnedReason:
      "resumes at-least-once work the system already owed; the redriven job's durable effects " +
      "are the system's, never state the operator originated",
    target: { type: 'job', field: 'jobId' },
    allowedRoles: ['operator'],
  }),
  'job.discard': defineAdminOpContract({
    name: 'job.discard',
    title: 'Discard dead job',
    kind: 'mutation',
    input: jobTargetInput,
    inverse: 'job.restore',
    effectClass: 'durable',
    target: { type: 'job', field: 'jobId' },
    allowedRoles: ['operator'],
  }),
  'job.restore': defineAdminOpContract({
    name: 'job.restore',
    title: 'Restore discarded job',
    kind: 'mutation',
    input: jobTargetInput,
    inverse: 'job.discard',
    effectClass: 'durable',
    target: { type: 'job', field: 'jobId' },
    allowedRoles: ['operator'],
  }),
  'model.disable': defineAdminOpContract({
    name: 'model.disable',
    title: 'Disable model',
    kind: 'mutation',
    input: modelTargetInput,
    inverse: 'model.enable',
    effectClass: 'durable',
    target: { type: 'model', field: 'modelId' },
    allowedRoles: ['operator'],
  }),
  'model.enable': defineAdminOpContract({
    name: 'model.enable',
    title: 'Enable model',
    kind: 'mutation',
    input: modelTargetInput,
    inverse: 'model.disable',
    effectClass: 'durable',
    target: { type: 'model', field: 'modelId' },
    allowedRoles: ['operator'],
  }),
  'share.revoke': defineAdminOpContract({
    name: 'share.revoke',
    title: 'Revoke shared link',
    kind: 'mutation',
    input: shareTargetInput,
    inverse: 'share.unrevoke',
    effectClass: 'durable',
    target: { type: 'shared_link', field: 'linkId' },
    allowedRoles: ['operator'],
  }),
  'share.unrevoke': defineAdminOpContract({
    name: 'share.unrevoke',
    title: 'Un-revoke shared link',
    kind: 'mutation',
    input: shareTargetInput,
    inverse: 'share.revoke',
    effectClass: 'durable',
    target: { type: 'shared_link', field: 'linkId' },
    allowedRoles: ['operator'],
  }),
  // Self-inverse: setting a status is undone by setting the prior status back
  // (the engine snapshots the old value into the inverse input), so the op is
  // its own registered inverse.
  'feedback.setStatus': defineAdminOpContract({
    name: 'feedback.setStatus',
    title: 'Set feedback status',
    kind: 'mutation',
    input: z.object({ feedbackId: z.uuid(), status: z.enum(FEEDBACK_STATUSES), reason }),
    inverse: 'feedback.setStatus',
    effectClass: 'durable',
    target: { type: 'feedback', field: 'feedbackId' },
    allowedRoles: ['operator'],
  }),
  // Self-inverse: the op body snapshots the prior banner config into the
  // inverse input. Zero messages is legal — the disabled state and the
  // undo-of-first-set both need it; "enabled ⇒ ≥1 message" is a cross-field
  // rule enforced in the op body, not here (the input must stay a plain
  // ZodObject so `adminOpCatalogEntry` can read `.shape`).
  'banner.set': defineAdminOpContract({
    name: 'banner.set',
    title: 'Set banner',
    kind: 'mutation',
    input: z.object({
      enabled: z.boolean(),
      messages: z.array(bannerMessageInput).max(MAX_BANNER_MESSAGES),
      reason,
    }),
    inverse: 'banner.set',
    effectClass: 'durable',
    target: null,
    allowedRoles: ['operator'],
  }),
  'newsletter.schedule': defineAdminOpContract({
    name: 'newsletter.schedule',
    title: 'Schedule newsletter issue',
    kind: 'mutation',
    input: z.object({
      subject: newsletterSubject,
      bodyMarkdown: newsletterBody,
      scheduledAt: z.iso.datetime(),
      reason,
    }),
    inverse: 'newsletter.cancel',
    effectClass: 'durable',
    // The issue id is minted inside the settlement transaction, so no
    // target is supplied with the request and the preview row's target
    // columns stay null; the executed row carries the minted id.
    target: null,
    allowedRoles: ['operator'],
  }),
  'newsletter.cancel': defineAdminOpContract({
    name: 'newsletter.cancel',
    title: 'Cancel scheduled newsletter issue',
    kind: 'mutation',
    input: z.object({ issueId: z.uuid(), reason }),
    inverse: 'newsletter.schedule',
    effectClass: 'durable',
    target: { type: 'newsletterIssue', field: 'issueId' },
    allowedRoles: ['operator'],
  }),
  // Ephemeral: sends a preview email to the acting admin only — no durable
  // product state exists afterward, so there is nothing to invert.
  'newsletter.testSend': defineAdminOpContract({
    name: 'newsletter.testSend',
    title: 'Send newsletter test email',
    kind: 'mutation',
    input: z.object({ subject: newsletterSubject, bodyMarkdown: newsletterBody, reason }),
    inverse: null,
    effectClass: 'ephemeral',
    target: null,
    allowedRoles: ['operator'],
  }),
  // The stranded-second-factor fallback: a TOTP secret sealed under a key the
  // build no longer holds cannot be verified, and every 2FA gate (login
  // promotion, disable, account deletion) refuses on it — so the account has
  // no exit until an operator clears the flag. Clearing RETAINS the
  // ciphertext, which is what makes the pair reversible and what distinguishes
  // the cleared state from a user's own disable. The caveat the operator must
  // understand: after a true key loss the inverse restores a state that is
  // still stranded — it undoes the operator's act, it does not recover the
  // secret.
  'twoFactor.clearStranded': defineAdminOpContract({
    name: 'twoFactor.clearStranded',
    title: 'Clear stranded second factors',
    kind: 'mutation',
    // `keys` narrows the act to named retired keys; absent means every retired
    // key — the sweep. The narrowed form is what a restore's undo runs, so
    // undoing a restore reaches only the keys that restore re-enabled; an
    // unscoped undo would re-measure every row against the live key and clear
    // second factors the restore never touched.
    input: z.object({
      keys: z.array(strandedTotpKey).min(1).max(MAX_STRANDED_TOTP_GROUPS).optional(),
      reason,
    }),
    inverse: 'twoFactor.restoreStranded',
    effectClass: 'durable',
    // The op names no target: even scoped, it acts on however many rows stand
    // under the named keys, which is a property of the rows rather than an
    // operator-supplied id.
    target: null,
    allowedRoles: ['operator'],
  }),
  'twoFactor.restoreStranded': defineAdminOpContract({
    name: 'twoFactor.restoreStranded',
    title: 'Restore cleared second factors',
    kind: 'mutation',
    // The groups the clear recorded: key id and count, never user ids. The
    // count is the referee — the restore applies only when exactly that many
    // rows still stand cleared under the key id, so one clear's undo can never
    // reach rows another clear touched.
    input: z.object({
      groups: z.array(strandedTotpGroup).min(1).max(MAX_STRANDED_TOTP_GROUPS),
      reason,
    }),
    inverse: 'twoFactor.clearStranded',
    effectClass: 'durable',
    target: null,
    allowedRoles: ['operator'],
  }),
  // The operator's only repair path for a payment whose money state no
  // mechanism can determine — the provider denied both the stored transaction
  // id and the merchant-reference search, or the row never carried an id to
  // ask about — so the reconciler has no fact to act on and a human rules
  // against the provider dashboard instead. All four are durable — the
  // operator originates the verdict, and each pairs with the op that puts the
  // row back.
  'payment.forceExpire': defineAdminOpContract({
    name: 'payment.forceExpire',
    title: 'Force-expire stuck payment',
    kind: 'mutation',
    input: paymentHandleInput,
    inverse: 'payment.restoreAwaitingWebhook',
    effectClass: 'durable',
    target: { type: 'payment', field: 'paymentId' },
    allowedRoles: ['operator'],
  }),
  'payment.restoreAwaitingWebhook': defineAdminOpContract({
    name: 'payment.restoreAwaitingWebhook',
    title: 'Restore payment to awaiting webhook',
    kind: 'mutation',
    input: paymentHandleInput,
    inverse: 'payment.forceExpire',
    effectClass: 'durable',
    target: { type: 'payment', field: 'paymentId' },
    allowedRoles: ['operator'],
  }),
  // No money guardrail: the amount is the row's own captured total, never an
  // operator input, so there is no field a `maxAmountNanoUsd` cap could bound.
  'payment.forceCompleteAndCredit': defineAdminOpContract({
    name: 'payment.forceCompleteAndCredit',
    title: 'Force-complete payment and credit',
    kind: 'mutation',
    input: paymentTargetInput,
    inverse: 'payment.uncompleteAndClawback',
    effectClass: 'durable',
    target: { type: 'payment', field: 'paymentId' },
    allowedRoles: ['operator'],
  }),
  'payment.uncompleteAndClawback': defineAdminOpContract({
    name: 'payment.uncompleteAndClawback',
    title: 'Un-complete payment and claw back',
    kind: 'mutation',
    input: paymentTargetInput,
    inverse: 'payment.forceCompleteAndCredit',
    effectClass: 'durable',
    target: { type: 'payment', field: 'paymentId' },
    allowedRoles: ['operator'],
  }),
  'twoFactor.clear': defineAdminOpContract({
    name: 'twoFactor.clear',
    title: 'Clear one account’s second factor',
    kind: 'mutation',
    input: userTargetInput,
    inverse: 'twoFactor.restore',
    effectClass: 'durable',
    target: { type: 'user', field: 'userId' },
    allowedRoles: ['operator'],
  }),
  'twoFactor.restore': defineAdminOpContract({
    name: 'twoFactor.restore',
    title: 'Restore one account’s second factor',
    kind: 'mutation',
    input: userTargetInput,
    inverse: 'twoFactor.clear',
    effectClass: 'durable',
    target: { type: 'user', field: 'userId' },
    allowedRoles: ['operator'],
  }),
  // The campaign pair: minting a tag and retiring it. A tag is the referent of
  // growth rows kept forever, so retiring changes a status and never deletes a
  // row — which is also what lets the create double as the archive's inverse,
  // returning a retired tag to active rather than adding a third operation
  // whose only purpose is to undo the second.
  'growth.campaign.create': defineAdminOpContract({
    name: 'growth.campaign.create',
    title: 'Create campaign',
    kind: 'mutation',
    description:
      'A campaign tag is a label every clicker shares, never a per-person identifier — the ' +
      'operation refuses a tag shaped like one.',
    input: z.object({ tag: campaignTagSchema, label: campaignLabelSchema, reason }),
    inverse: 'growth.campaign.archive',
    effectClass: 'durable',
    target: { type: 'campaign', field: 'tag' },
    allowedRoles: ['operator'],
  }),
  'growth.campaign.archive': defineAdminOpContract({
    name: 'growth.campaign.archive',
    title: 'Archive campaign',
    kind: 'mutation',
    description:
      'The row survives with its status changed, so the counts collected under the tag still ' +
      'resolve; creating the tag again returns it to active.',
    input: z.object({ tag: campaignTagSchema, reason }),
    inverse: 'growth.campaign.create',
    effectClass: 'durable',
    target: { type: 'campaign', field: 'tag' },
    allowedRoles: ['operator'],
  }),
  // The growth reads. Each is `ephemeral` because a read leaves nothing
  // durable behind — its body takes no settlement transaction handle at all —
  // and each lists the read-only role beside the operator, which is what makes
  // the operations catalogue non-empty for a viewer.
  'growth.freshness.read': defineAdminOpContract({
    name: 'growth.freshness.read',
    title: 'Read growth data currency',
    kind: 'read',
    description:
      'The newest day each growth data set holds, over the whole of that set. It takes no ' +
      'window, because a figure a window could move would measure the window rather than the ' +
      'data; a set holding nothing answers with no day at all.',
    input: z.object({}),
    inverse: null,
    effectClass: 'ephemeral',
    target: null,
    allowedRoles: ['operator', 'growth-viewer'],
  }),
  'growth.funnel.read': defineAdminOpContract({
    name: 'growth.funnel.read',
    title: 'Read growth funnel',
    kind: 'read',
    description: BUCKET_MAXIMUM_NOTE,
    input: z.object({ ...growthWindowInput, campaign: campaignTagSchema.optional() }),
    inverse: null,
    effectClass: 'ephemeral',
    target: null,
    allowedRoles: ['operator', 'growth-viewer'],
  }),
  'growth.marketing.read': defineAdminOpContract({
    name: 'growth.marketing.read',
    title: 'Read marketing counts',
    kind: 'read',
    description:
      'Each family is a separate marginal and none of them may be joined to another: a ' +
      'distinct count over a cross product is not derivable from the counts of its projections.',
    input: z.object({ ...growthWindowInput, grain: z.enum(GROWTH_GRAIN) }),
    inverse: null,
    effectClass: 'ephemeral',
    target: null,
    allowedRoles: ['operator', 'growth-viewer'],
  }),
  'growth.sources.read': defineAdminOpContract({
    name: 'growth.sources.read',
    title: 'Read acquisition sources',
    kind: 'read',
    description:
      'Accounts by where their signup link said they came from and what the account holder ' +
      'said when asked; the primary source prefers the person’s own answer.',
    input: z.object(growthWindowInput),
    inverse: null,
    effectClass: 'ephemeral',
    target: null,
    allowedRoles: ['operator', 'growth-viewer'],
  }),
  'growth.campaigns.read': defineAdminOpContract({
    name: 'growth.campaigns.read',
    title: 'Read campaigns',
    kind: 'read',
    description:
      'Every campaign, archived ones included: a retired tag still owns the counts it ' +
      'collected while it ran.',
    input: z.object({}),
    inverse: null,
    effectClass: 'ephemeral',
    target: null,
    allowedRoles: ['operator', 'growth-viewer'],
  }),
  'growth.events.read': defineAdminOpContract({
    name: 'growth.events.read',
    title: 'Read named events',
    kind: 'read',
    description:
      'Visitors per named event per hour. Each hour’s figure is a lower bound where a ceiling ' +
      'overflowed, and the row says so.',
    input: z.object({
      ...growthWindowInput,
      campaign: campaignTagSchema.optional(),
      path: growthPathFilter.optional(),
      page: z.number().int().min(0).default(0),
    }),
    inverse: null,
    effectClass: 'ephemeral',
    target: null,
    allowedRoles: ['operator', 'growth-viewer'],
  }),
  'growth.reach.read': defineAdminOpContract({
    name: 'growth.reach.read',
    title: 'Read landing to reached',
    kind: 'read',
    description:
      'Visitors who landed on one page and reached another the same day, summed over the days ' +
      'in the window — a day has its own set, so someone who came back counts on each day.',
    input: z.object(growthWindowInput),
    inverse: null,
    effectClass: 'ephemeral',
    target: null,
    allowedRoles: ['operator', 'growth-viewer'],
  }),
} as const;

/** All registered op names — the registry-exhaustiveness iteration source. */
export const ADMIN_OP_NAMES = Object.keys(
  ADMIN_OP_CONTRACTS
) as readonly (keyof typeof ADMIN_OP_CONTRACTS)[];

export type AdminOpContractName = keyof typeof ADMIN_OP_CONTRACTS;
