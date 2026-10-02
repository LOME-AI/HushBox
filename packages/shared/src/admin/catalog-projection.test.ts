import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { adminOpCatalogEntry } from './catalog-projection.ts';
import { defineAdminOpContract } from './contract.ts';
import { ADMIN_OP_CONTRACTS, ADMIN_OP_NAMES, ADMIN_WALLET_ADJUSTMENT_CAP_NANO_USD } from './ops.ts';
import type { AdminOpContractName } from './ops.ts';

const reason = z.string().regex(/\S/);

const durableContract = defineAdminOpContract({
  name: 'unit.credit',
  title: 'Credit something',
  kind: 'mutation',
  input: z.object({ targetId: z.uuid(), reason }),
  inverse: 'unit.clawback',
  effectClass: 'durable',
  target: { type: 'thing', field: 'targetId' },
  allowedRoles: ['operator'],
  guardrails: { maxAmountNanoUsd: 1_000_000_000n },
});

describe('adminOpCatalogEntry', () => {
  it('projects the contract identity and its input field names', () => {
    expect(adminOpCatalogEntry(durableContract)).toEqual({
      name: 'unit.credit',
      title: 'Credit something',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'unit.clawback',
      fields: ['targetId', 'reason'],
      guardrails: { maxAmountNanoUsd: '1000000000' },
    });
  });

  it('omits guardrails entirely when the contract declares none', () => {
    const entry = adminOpCatalogEntry(
      defineAdminOpContract({
        name: 'unit.bare',
        title: 'No guardrails',
        kind: 'mutation',
        input: z.object({ reason }),
        inverse: null,
        effectClass: 'ephemeral',
        target: null,
        allowedRoles: ['operator'],
      })
    );
    expect('guardrails' in entry).toBe(false);
  });

  it('keeps guardrails present when the contract declares them without a money cap', () => {
    const entry = adminOpCatalogEntry(
      defineAdminOpContract({
        name: 'unit.cappless',
        title: 'Guardrails without a cap',
        kind: 'mutation',
        input: z.object({ reason }),
        inverse: null,
        effectClass: 'ephemeral',
        target: null,
        allowedRoles: ['operator'],
        guardrails: {},
      })
    );
    expect(entry.guardrails).toEqual({});
  });

  it('carries the stated reason of a system-owned op', () => {
    const entry = adminOpCatalogEntry(
      defineAdminOpContract({
        name: 'unit.systemOwned',
        title: 'System-owned effect',
        kind: 'mutation',
        input: z.object({ reason }),
        inverse: null,
        effectClass: 'system-owned',
        systemOwnedReason: 'resumes work the system already owed',
        target: null,
        allowedRoles: ['operator'],
      })
    );
    expect(entry.systemOwnedReason).toBe('resumes work the system already owed');
  });

  it('omits the stated reason on an op that is not system-owned', () => {
    expect('systemOwnedReason' in adminOpCatalogEntry(durableContract)).toBe(false);
  });
});

/**
 * The field list `GET /admin/ops` serves for each registered op, written out
 * rather than read back from the contracts. The SPA builds a registered op's
 * form from its bundled contract and reads the served list only for an op
 * that bundle does not carry (the reason on `adminOpWireSchema.fields`), so
 * nothing that renders the catalog fails when a list is wrong — this table is
 * what fails instead, and only if it states the lists literally.
 */
const REGISTERED_OP_FIELDS: Record<AdminOpContractName, readonly string[]> = {
  'wallet.credit': ['walletId', 'amountNanoUsd', 'reason'],
  'wallet.clawback': ['walletId', 'amountNanoUsd', 'reason'],
  'user.lock': ['userId', 'lockReason', 'reason'],
  'user.unlock': ['userId', 'reason'],
  'sessions.revokeAll': ['userId', 'reason'],
  'job.redrive': ['jobId', 'reason'],
  'job.discard': ['jobId', 'reason'],
  'job.restore': ['jobId', 'reason'],
  'model.disable': ['modelId', 'reason'],
  'model.enable': ['modelId', 'reason'],
  'share.revoke': ['linkId', 'reason'],
  'share.unrevoke': ['linkId', 'reason'],
  'feedback.setStatus': ['feedbackId', 'status', 'reason'],
  'banner.set': ['enabled', 'messages', 'reason'],
  'newsletter.schedule': ['subject', 'bodyMarkdown', 'scheduledAt', 'reason'],
  'newsletter.cancel': ['issueId', 'reason'],
  'newsletter.testSend': ['subject', 'bodyMarkdown', 'reason'],
  'payment.forceExpire': ['paymentId', 'helcimTransactionId', 'reason'],
  'payment.restoreAwaitingWebhook': ['paymentId', 'helcimTransactionId', 'reason'],
  'payment.forceCompleteAndCredit': ['paymentId', 'reason'],
  'payment.uncompleteAndClawback': ['paymentId', 'reason'],
  'twoFactor.clearStranded': ['keys', 'reason'],
  'twoFactor.restoreStranded': ['groups', 'reason'],
  'twoFactor.clear': ['userId', 'reason'],
  'twoFactor.restore': ['userId', 'reason'],
  'growth.campaign.create': ['tag', 'label', 'reason'],
  'growth.campaign.archive': ['tag', 'reason'],
  'growth.freshness.read': [],
  'growth.funnel.read': ['from', 'to', 'campaign'],
  'growth.marketing.read': ['from', 'to', 'grain'],
  'growth.sources.read': ['from', 'to'],
  'growth.campaigns.read': [],
  'growth.events.read': ['from', 'to', 'campaign', 'path', 'page'],
  'growth.reach.read': ['from', 'to'],
};

describe('the catalog entry of every registered op', () => {
  it.each(ADMIN_OP_NAMES)('serves the input field names of %s', (name) => {
    expect(adminOpCatalogEntry(ADMIN_OP_CONTRACTS[name]).fields).toEqual(
      REGISTERED_OP_FIELDS[name]
    );
  });
});

/**
 * The guardrail content `GET /admin/ops` serves for each registered op. Caps
 * name the exported constant the contract builds its guardrail from, never
 * the contract's own `guardrails` object: that object is what the projection
 * reads, so an expectation derived from it would restate the projection's own
 * expression instead of pinning it. Naming the constant means both sides of a
 * case here move with it, which fixes what these cases can catch. Measured
 * over this file, one declaration rewritten at a time: a contract cap that
 * diverges from the constant reds both wallet cases here, and an op that
 * starts declaring guardrails reds its own case, while every constant value
 * tried — doubled, five nano-USD, zero, negative — reds no case in this file.
 * The cap's magnitude is therefore not what this file pins; look elsewhere
 * for it. Guardrails declared with no money cap must survive as `{}` rather
 * than collapse to absent; this file's case for that is `keeps guardrails
 * present when the contract declares them without a money cap`, which reds
 * when the projection collapses them. The engine enforces the cap off the
 * contract rather than off the wire (`guardrailViolation` in
 * `apps/api/src/slices/admin/domain/engine.ts`), so a wrong served cap shows
 * an operator a limit the engine does not apply.
 */
const REGISTERED_OP_GUARDRAIL_CAPS: Record<AdminOpContractName, bigint | null> = {
  'wallet.credit': ADMIN_WALLET_ADJUSTMENT_CAP_NANO_USD,
  'wallet.clawback': ADMIN_WALLET_ADJUSTMENT_CAP_NANO_USD,
  'user.lock': null,
  'user.unlock': null,
  'sessions.revokeAll': null,
  'job.redrive': null,
  'job.discard': null,
  'job.restore': null,
  'model.disable': null,
  'model.enable': null,
  'share.revoke': null,
  'share.unrevoke': null,
  'feedback.setStatus': null,
  'banner.set': null,
  'newsletter.schedule': null,
  'newsletter.cancel': null,
  'newsletter.testSend': null,
  'payment.forceExpire': null,
  'payment.restoreAwaitingWebhook': null,
  'payment.forceCompleteAndCredit': null,
  'payment.uncompleteAndClawback': null,
  'twoFactor.clearStranded': null,
  'twoFactor.restoreStranded': null,
  'twoFactor.clear': null,
  'twoFactor.restore': null,
  'growth.campaign.create': null,
  'growth.campaign.archive': null,
  'growth.freshness.read': null,
  'growth.funnel.read': null,
  'growth.marketing.read': null,
  'growth.sources.read': null,
  'growth.campaigns.read': null,
  'growth.events.read': null,
  'growth.reach.read': null,
};

describe('the guardrail content of every registered op', () => {
  it.each(ADMIN_OP_NAMES)('serves the guardrails %s declares', (name) => {
    const cap = REGISTERED_OP_GUARDRAIL_CAPS[name];
    const entry = adminOpCatalogEntry(ADMIN_OP_CONTRACTS[name]);
    expect('guardrails' in entry ? entry.guardrails : null).toEqual(
      cap === null ? null : { maxAmountNanoUsd: cap.toString(10) }
    );
  });
});

describe('adminOpCatalogEntry description', () => {
  it('carries the contract’s own sentence to the operator', () => {
    const entry = adminOpCatalogEntry(
      defineAdminOpContract({
        name: 'unit.described',
        title: 'Described op',
        kind: 'read',
        description: 'The number is a lower bound.',
        input: z.object({}),
        inverse: null,
        effectClass: 'ephemeral',
        target: null,
        allowedRoles: ['operator'],
      })
    );

    expect(entry.description).toBe('The number is a lower bound.');
  });

  it('omits the field entirely when the contract states none', () => {
    expect('description' in adminOpCatalogEntry(durableContract)).toBe(false);
  });
});
