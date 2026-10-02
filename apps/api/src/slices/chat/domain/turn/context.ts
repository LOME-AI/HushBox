import { ERROR_CODES, resolveFunding, spendableFundsNanoUsd } from '@hushbox/shared';
import { readBalance } from '../../../billing/index.js';
import { assertNoPendingDeparture, resolveCallerMember } from '../../../conversations/index.js';
import { forbiddenError, notFoundError } from '../../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { senderCaller, senderUserId } from '../messages/sender.js';
import { turnMinCost } from './pricing.js';
import type {
  FundingInputs,
  MemberPrivilege,
  ModelDescriptor,
  SenderPrincipal,
} from '@hushbox/shared';
import type { TurnPricingSelection } from './pricing.js';
import type { createConversationsStores } from '../../../conversations/index.js';
import type { MemberRecord, RealtimeBroadcast } from '../../../conversations/index.js';
import type { BillingStores } from '../../../billing/index.js';
import type { LinkResolutionPort } from '../../../identity/index.js';
import type { Database } from '@hushbox/db';
import type { AppEnv } from '../../../../lib/context/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { ChatStores } from '../../ports/stores.js';
import type { EpochPublicKeyReader } from '../settlement/settlement.js';

/**
 * The conversation-scoped store factory, named from its published barrel
 * constructor so the route can hold the factory without reaching a
 * conversations internal.
 */
export type ConversationsStoresFactory = typeof createConversationsStores;

/**
 * The chat route's injected collaborators: the conversations store factory
 * (membership + current epoch), billing's stores (the paying wallet), and the
 * ConversationRoom DO client. Wired at app assembly; a port double in tests.
 */
export interface ChatRouteDeps {
  readonly conversations: ConversationsStoresFactory;
  readonly billing: BillingStores;
  readonly realtime: (env: AppEnv['Bindings']) => RealtimeBroadcast;
  /**
   * chat's single-writer content persister (`messages` + `content_items`) for
   * the runless Pattern-A user-only send. Routes and domain may not reach the
   * slice's own adapter, so the slice-root manifest composer defaults it —
   * the same seam `conversation-runtime.ts` uses for the DO runtime.
   */
  readonly chatStores: ChatStores;
  /**
   * The `epochs` wrap-key read the user-only send wraps its content to — the
   * same seam the settlement consumes; defaulted by the slice's manifest
   * composer.
   */
  readonly readEpochPublicKey: EpochPublicKeyReader;
  /**
   * The trial DO-id builder (`@hushbox/realtime`'s `trialRoomName`). Injected
   * rather than imported here because value-importing the realtime barrel drags
   * in the workerd-only DO class, which cannot load in node-environment tests;
   * the composition root (workerd) supplies the real one.
   */
  readonly trialRoomName: (sessionId: string) => string;
  /**
   * Shared-link credential resolution (identity's port over conversations'
   * shared-link store), per request. The public guest-send seam resolves the
   * presented `x-link-auth` token to a link guest through it — the same seam
   * the guest-reachable conversation reads and media presign use — so a guest's
   * `linkId`/`conversationId` are SERVER-derived, never trusted from the body.
   */
  readonly linkResolution: (db: Database) => LinkResolutionPort;
  /**
   * The runless user-only send's best-effort push side-band, mirroring the
   * room's AI-turn `RoomNotify`: a committed human message notifies absent,
   * non-muted members (present members suppressed via the fire-time presence
   * snapshot; the sender excluded). A per-request FACTORY like `realtime` and
   * `conversations` — it captures the request `env` (push config) and `db`
   * (membership + device tokens), so it cannot be a pre-bound closure the way
   * the DO's per-instance one is. It takes the request's composed telemetry
   * alongside them, because a sink the capability minted for itself would be
   * console-only — retained nowhere — so a total push failure would page
   * nobody. Optional: a caller that wires no push (every
   * test that does not exercise it) fires none. Content-free by construction —
   * the message never reaches the payload. The composition root binds the same
   * adapter the DO's AI-turn push uses.
   */
  readonly notifyNewMessage?: (
    env: AppEnv['Bindings'],
    db: Database,
    telemetry: Telemetry
  ) => NotifyNewMessage;
}

/**
 * A committed new message's best-effort push, mirroring `@hushbox/realtime`'s
 * `RoomNotify`: given the conversation, the sender, and the users present at
 * fire time (suppressed downstream), it delivers a content-free notification to
 * everyone else eligible. Never throws and never blocks the response.
 */
export type NotifyNewMessage = (args: {
  readonly conversationId: string;
  readonly senderUserId: string;
  readonly presentUserIds: readonly string[];
}) => Promise<void>;

/**
 * The payer's spendable funds for ONE turn, feeding the output-token ceiling.
 * ALREADY SPENDABLE: the cushion (where one applies) is resolved here, at the
 * seam that picks the wallet, by the one function that answers what a wallet can
 * spend. Nothing downstream re-derives it — a second derivation is how the
 * freeze and the ceiling solve came to disagree by $0.50, and a group turn's
 * figure is a MIN of independent caps that no later cushion may lift.
 *
 * `kind` remains the payer's tier for grading which models the turn may use
 * (premium access). It is deliberately no longer an input to any money term.
 */
export interface PayerFunding {
  readonly spendableNanoUsd: bigint;
  readonly kind: 'purchased' | 'free';
}

/**
 * The primitive funding inputs resolved from the DB, minus the
 * model-tier flag — everything the shared {@link resolveFunding} core
 * needs except `isPremiumModel`. Frozen onto the {@link TurnContext} so the
 * premium tier gate re-runs the SAME core with the selected model's premium
 * classification, instead of re-deriving the funding branching itself.
 */
export type FundingDecisionInputs = Omit<FundingInputs, 'isPremiumModel'>;

/** The turn preconditions resolved from conversations + billing before the run starts. */
export interface TurnContext {
  readonly epochNumber: number;
  readonly walletId: string;
  readonly funding: PayerFunding;
  /**
   * The turn's SENDER as the route resolved it server-side — a full-session
   * user (by `userId`) or a link guest (by the `linkId` its credential resolved
   * to) — and the seam that lets a guest send be represented at all. The PAYER
   * is derived from this plus the conversation owner: a solo/self-funded user
   * pays their own wallet, an owner-funded group turn (user or guest) pays the
   * owner's, and a guest with no owner headroom is denied (guests hold no
   * wallet).
   */
  readonly sender: SenderPrincipal;
  /**
   * The paying user account — the owner of `walletId`, whoever that is: the
   * sender when they fund themselves, the conversation OWNER on an owner-funded
   * turn (a member's or a guest's alike). It never depends on the sender's
   * principal kind, which is what makes the billed row's payer column
   * aggregatable; who SENT rides `sender`.
   */
  readonly payerUserId: string;
  /**
   * The privilege on the sender's active member row, carried out of the
   * membership read this resolution already performs so the route's send-privilege
   * gate costs no second read. Read per turn rather than off the credential, which
   * is what makes a demotion take effect on the caller's next request.
   */
  readonly senderPrivilege: MemberPrivilege;
  /**
   * The primitive funding inputs behind the frozen payer wallet, for the
   * premium tier gate to re-run {@link resolveFunding} against the
   * selected model — so the who-pays and premium decisions share one core.
   */
  readonly fundingDecisionInputs: FundingDecisionInputs;
}

export interface ResolveTurnContextDeps {
  readonly conversations: ConversationsStoresFactory;
  readonly billing: BillingStores;
}

type Stores = ReturnType<ConversationsStoresFactory>;

/**
 * The sender must be an active member; the returned row's id names their durable
 * per-member budget. Resolved through the shared `resolveCallerMember` gate — a
 * user by `userId`, a link guest by `linkId` — so a revoked/departed sender (its
 * row marked left) resolves to `null` here and the turn is forbidden, and one
 * gate serves both principal kinds.
 */
function requireSenderMember(
  stores: Stores,
  conversationId: string,
  sender: SenderPrincipal
): ResultAsync<MemberRecord, DomainError> {
  return resolveCallerMember(stores, conversationId, senderCaller(sender, conversationId)).andThen(
    (member) =>
      member === null
        ? errAsync<MemberRecord, DomainError>(
            forbiddenError('chat turn: caller is not an active member of the conversation')
          )
        : okAsync<MemberRecord, DomainError>(member)
  );
}

/** The conversation-derived turn facts: the wrap-target epoch, the owner, and the group cap. */
interface ConversationFacts {
  readonly epochNumber: number;
  readonly ownerUserId: string;
  /** The durable per-conversation budget cap (owner-set); `0n` when none configured. */
  readonly conversationBudgetNanoUsd: bigint;
}

/**
 * The conversation must exist; its current epoch is the content wrap target, its
 * owner is the potential funding principal, and its per-conversation cap gates a
 * group turn's group-funded headroom. A current epoch a departed seat still holds
 * is refused before the run starts: the run's content would wrap to a key the
 * departed member can open.
 */
function requireConversation(
  stores: Stores,
  conversationId: string
): ResultAsync<ConversationFacts, DomainError> {
  return stores.conversations.get(conversationId).andThen((conversation) =>
    conversation === null
      ? errAsync<ConversationFacts, DomainError>(notFoundError('chat turn: conversation not found'))
      : assertNoPendingDeparture(stores, conversationId).map(
          (): ConversationFacts => ({
            epochNumber: conversation.currentEpoch,
            ownerUserId: conversation.ownerUserId,
            conversationBudgetNanoUsd: conversation.conversationBudgetNanoUsd,
          })
        )
  );
}

/**
 * A send onto a fork must reference an existing branch: reject a stale/bogus
 * forkId with a 404 before the run starts, rather than admit a paid run that
 * would only terminal-fail at settlement. The boolean is a gate token, unused.
 */
function requireFork(
  stores: Stores,
  conversationId: string,
  forkId: string
): ResultAsync<boolean, DomainError> {
  return stores.forks
    .byId(conversationId, forkId)
    .andThen((fork) =>
      fork === null
        ? errAsync<boolean, DomainError>(notFoundError('chat turn: fork not found'))
        : okAsync<boolean, DomainError>(true)
    );
}

/** The payer wallet plus its spendable funds — the shape the funding decision yields. */
interface PayerWallet {
  readonly walletId: string;
  /**
   * The wallet's owner — the paying account. Minted by the same branch that
   * chose the wallet, so the payer identity and the debited wallet cannot name
   * different people; the billed row records this as its payer.
   */
  readonly payerUserId: string;
  readonly funding: PayerFunding;
}

/**
 * A self-funding materialization: the chosen wallet plus the caller's own
 * purchased-wallet balance, which the funding core needs (`> 0` gates both the
 * purchased-wallet choice and premium access) and which the tier gate reuses.
 */
interface SelfFunding {
  readonly wallet: PayerWallet;
  readonly callerPurchasedBalanceNanoUsd: bigint;
}

/** The resolved payer wallet plus the primitives behind the decision. */
interface ResolvedPayer {
  readonly wallet: PayerWallet;
  readonly inputs: FundingDecisionInputs;
}

/**
 * The sender's payer wallet: their purchased wallet while it carries a positive
 * balance, otherwise their free wallet — the daily-allowance draw. Admission is
 * the only balance gate, so a purchased balance of `≤ 0` (a spent-down or
 * negative wallet) falls through to the free wallet, whose sole ceiling is the
 * daily allowance (emitted by the admission hook, which recovers the free-tier
 * decision from the payer wallet's type). A genuinely absent purchased wallet cannot
 * fund a turn (forbidden); the free wallet is provisioned alongside it at
 * registration. The purchased arm's funding is the wallet's SPENDABLE figure
 * (balance plus its cushion); the free arm's is the remaining daily allowance,
 * which is a budget scope rather than a balance and is never cushioned.
 */
function senderPayerWallet(
  billing: BillingStores,
  db: Database,
  userId: string,
  now: Date
): ResultAsync<SelfFunding, DomainError> {
  return billing.readWallets(db, userId).andThen((wallets) => {
    const purchased = wallets.find((wallet) => wallet.type === 'purchased');
    if (purchased === undefined) {
      return errAsync<SelfFunding, DomainError>(forbiddenError('chat turn: no purchased wallet'));
    }
    if (purchased.balanceNanoUsd > 0n) {
      return okAsync<SelfFunding, DomainError>({
        wallet: {
          walletId: purchased.id,
          payerUserId: userId,
          funding: {
            spendableNanoUsd: spendableFundsNanoUsd(purchased.balanceNanoUsd),
            kind: 'purchased',
          },
        },
        callerPurchasedBalanceNanoUsd: purchased.balanceNanoUsd,
      });
    }
    const free = wallets.find((wallet) => wallet.type === 'free');
    /* v8 ignore next 3 -- the free wallet is provisioned with the purchased wallet at registration; its absence is a defect, not a reachable state */
    if (free === undefined) {
      return errAsync<SelfFunding, DomainError>(forbiddenError('chat turn: no free wallet'));
    }
    return readBalance(billing, db, userId, now).map((balance) => ({
      wallet: {
        walletId: free.id,
        payerUserId: userId,
        funding: { spendableNanoUsd: balance.allowance.remainingNanoUsd, kind: 'free' as const },
      },
      callerPurchasedBalanceNanoUsd: purchased.balanceNanoUsd,
    }));
  });
}

/** The inputs the group funding decision reads the durable spend/cap rows against. */
interface GroupFundingArgs {
  readonly sender: SenderPrincipal;
  readonly ownerUserId: string;
  readonly memberId: string;
  readonly conversationId: string;
  readonly conversationBudgetNanoUsd: bigint;
  /** The turn's minimum, which no payer term enters, so it is the same whoever pays. */
  readonly minTurnCostNanoUsd: bigint | undefined;
}

/**
 * Picks the payer wallet — the single funding decision, made ONCE at route time
 * (mirroring legacy `fundingSource`). It records the wallet's owner as the run's
 * payer, so the admission and settlement seams read who paid off the run identity
 * rather than re-deriving it from wallet ownership.
 *
 * A SOLO turn (a user sender who owns the conversation) funds from the owner's
 * own wallet — the personal path, unchanged. A GROUP turn (a user sender ≠ owner,
 * or ANY link guest) has the shared core compute the effective group headroom =
 * `min(memberRemaining, conversationRemaining, ownerSpendable)`, where the owner
 * dimension is what that wallet can spend (balance plus its cushion): headroom
 * that COVERS THE TURN'S MINIMUM
 * funds from the OWNER's wallet (owner-funded — both group caps gate admission
 * and settlement accrues group spend); headroom that cannot — exhausted, absent,
 * the owner in the red, or simply too small for this turn — falls a USER sender
 * through to its OWN wallet (self-funded — no group scopes, no group accrual)
 * and DENIES a LINK GUEST (it holds no wallet to fall through to). An absent
 * member-budget row reads a zero cap.
 *
 * Comparing the minimum rather than mere positivity is what keeps the two
 * outcomes reachable: headroom below it can never fund this turn, so freezing
 * the owner as payer would hand admission a scope it must refuse, and the same
 * send would be refused on every retry.
 */
function resolvePayerWallet(
  billing: BillingStores,
  db: Database,
  args: GroupFundingArgs,
  now: Date
): ResultAsync<ResolvedPayer, DomainError> {
  if (senderUserId(args.sender) === args.ownerUserId) {
    // Solo: the sender IS the owner and always self-funds. No group rows are
    // read (the caller wallet is enough), and the caller's purchased balance
    // stands in for the owner dimension in the frozen inputs.
    return senderPayerWallet(billing, db, args.ownerUserId, now).map((self) => ({
      wallet: self.wallet,
      inputs: {
        isSolo: true,
        isGuest: false,
        memberRemainingNanoUsd: 0n,
        conversationRemainingNanoUsd: 0n,
        ownerPurchasedBalanceNanoUsd: self.callerPurchasedBalanceNanoUsd,
        callerOwnPurchasedBalanceNanoUsd: self.callerPurchasedBalanceNanoUsd,
        // Carried on both branches so the field means one thing — this turn's
        // minimum — rather than "the group comparison ran". A solo turn never
        // reaches priority 1, so nothing reads it here.
        minTurnCostNanoUsd: args.minTurnCostNanoUsd,
      },
    }));
  }
  // One read after the other: the request's database is serial and refuses a
  // read issued while another is in flight.
  const groupRows = billing
    .readWallets(db, args.ownerUserId)
    .andThen((ownerWallets) =>
      billing
        .readMemberBudget(db, args.memberId)
        .andThen((memberRow) =>
          billing
            .readConversationSpent(db, args.conversationId)
            .map((conversationSpent) => ({ ownerWallets, memberRow, conversationSpent }))
        )
    );
  return groupRows.andThen(({ ownerWallets, memberRow, conversationSpent }) => {
    const ownerPurchased = ownerWallets.find((wallet) => wallet.type === 'purchased');
    const ownerBalance = ownerPurchased?.balanceNanoUsd ?? 0n;
    const memberRemaining =
      memberRow === null ? 0n : memberRow.budgetNanoUsd - memberRow.spentNanoUsd;
    const conversationRemaining = args.conversationBudgetNanoUsd - conversationSpent;
    // The who-pays decision comes from the shared core, not an inline branch.
    // The caller's own purchased balance is left `0n` here: it is irrelevant to
    // the owner-funded and guest-refuse verdicts, and the fall-through verdict
    // is `self` regardless of its value — the real balance is read below and
    // frozen for the tier gate. `isPremiumModel` is `false`: who-pays is
    // tier-agnostic (the tier gate re-runs the core with the model).
    // The minimum carries no payer term, so it is one number whichever payer
    // the decision picks, and the decision can read it before the payer is
    // known. A member who falls through pays from their own wallet, which the
    // fall-through below freezes, so the turn's ceiling sizes against the
    // sender's funding.
    const groupInputs: FundingDecisionInputs = {
      isSolo: false,
      isGuest: args.sender.kind === 'linkGuest',
      memberRemainingNanoUsd: memberRemaining,
      conversationRemainingNanoUsd: conversationRemaining,
      ownerPurchasedBalanceNanoUsd: ownerBalance,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      minTurnCostNanoUsd: args.minTurnCostNanoUsd,
    };
    const decision = resolveFunding({ ...groupInputs, isPremiumModel: false });
    if (decision.payer === 'owner') {
      // Owner-funded: the spendable funds are the headroom the core reached its
      // verdict on — the tightest of the member cap, the conversation cap and the
      // owner wallet's spendable funds. Read off the decision rather than
      // recomputed here: the freeze and the ceiling solve must consult ONE value,
      // and a second min over the same dimensions is a copy that has to agree.
      /* v8 ignore next 5 -- payer 'owner' requires positive headroom, which requires a positive owner balance and thus a purchased owner wallet; the undefined arm is unreachable */
      return ownerPurchased === undefined
        ? errAsync<ResolvedPayer, DomainError>(
            forbiddenError('chat turn: owner has no purchased wallet')
          )
        : okAsync<ResolvedPayer, DomainError>({
            wallet: {
              walletId: ownerPurchased.id,
              payerUserId: args.ownerUserId,
              funding: { spendableNanoUsd: decision.spendableNanoUsd, kind: 'purchased' },
            },
            inputs: groupInputs,
          });
    }
    // Not owner-funded (the core's refuse/self verdict). A link guest holds no
    // wallet to fall through to, so its send is denied (the core's
    // GROUP_BUDGET_EXHAUSTED refusal); a signed-in member self-funds on their
    // own wallet. Branching on the sender kind here both narrows the type and
    // encodes that materialization rule.
    if (args.sender.kind === 'linkGuest') {
      return errAsync<ResolvedPayer, DomainError>(
        forbiddenError(
          'chat turn: link guest has no funds and the owner cannot cover the turn',
          undefined,
          // Typed wire projection: the shared funding core's refusal code, so
          // the client maps the denial to the owner-allocated-budget remedy
          // copy instead of the generic FORBIDDEN permission copy.
          ERROR_CODES.GROUP_BUDGET_EXHAUSTED
        )
      );
    }
    // Fall-through: freeze the real caller balance so the tier gate's core call
    // sees it.
    return senderPayerWallet(billing, db, args.sender.userId, now).map((self) => ({
      wallet: self.wallet,
      inputs: {
        ...groupInputs,
        callerOwnPurchasedBalanceNanoUsd: self.callerPurchasedBalanceNanoUsd,
      },
    }));
  });
}

/**
 * Resolves the turn's preconditions: the caller must be an active member, the
 * conversation must exist (its current epoch is the wrap target), a fork send
 * must name an existing branch, and the payer wallet is chosen by the single
 * funding decision (`resolvePayerWallet`) — the owner's wallet for a solo turn
 * or an owner-funded group turn, the sender's own wallet for a fallen-through
 * group turn. The admission hold and the settlement charge fund from that one
 * wallet in lockstep.
 *
 * THE FREEZE PRICES ITSELF. The turn's minimum is derived here, from the
 * selection and the catalog snapshot, through {@link turnMinCost} — the caller
 * cannot hand one in. A payer chosen against a minimum that belongs to a
 * different turn is chosen against `headroom > 0` in disguise, which admits
 * sends that admission then refuses on every retry; taking the amount as an
 * argument made that a caller obligation, and a second turn route could forget
 * it silently. There is nothing to forget now.
 */
export function resolveTurnContext(
  deps: ResolveTurnContextDeps,
  db: Database,
  args: {
    readonly conversationId: string;
    readonly sender: SenderPrincipal;
    readonly forkId?: string | undefined;
    /** The clock the free payer's daily allowance is keyed by (UTC day). */
    readonly now: Date;
    /**
     * The catalog snapshot the minimum is priced against — read once by the
     * caller above this freeze and shared with the model-selection gates, so
     * one snapshot prices the turn and classifies its models.
     */
    readonly exposedCatalog: readonly ModelDescriptor[];
    /**
     * The priced half of the request: what the client selected, and how. Every
     * turn SHAPE prices a minimum — text through the summed-rate corner, media
     * through its deterministic per-unit price, a Smart Model slot through its
     * balance-independent pool threshold. A selection that prices nothing is
     * not a shape exemption: it means nothing in the selection prices at all,
     * which the turn build refuses on its own, so who would have paid never
     * matters.
     */
    readonly selection: TurnPricingSelection;
    /**
     * The prompt the turn will send, measured through the ONE shared counter —
     * the same number the turn budget carries, so the minimum and the
     * admission estimate price the identical prompt.
     */
    readonly promptCharacterCount: number;
    /**
     * The new user message inside it, which is the storage basis: the minimum
     * reserves the prompt storage settlement will bill, and a re-run that
     * stores no message carries none. The turn budget's own field, so the
     * freeze and the admission stamp cannot disagree about what rests.
     */
    readonly inputCharacterCount: number;
  }
): ResultAsync<TurnContext, DomainError> {
  const stores = deps.conversations(db);
  return requireSenderMember(stores, args.conversationId, args.sender).andThen((member) =>
    requireConversation(stores, args.conversationId)
      .andThen((facts) =>
        (args.forkId === undefined
          ? okAsync<boolean, DomainError>(true)
          : requireFork(stores, args.conversationId, args.forkId)
        ).map(() => facts)
      )
      .andThen((facts) =>
        resolvePayerWallet(
          deps.billing,
          db,
          {
            sender: args.sender,
            ownerUserId: facts.ownerUserId,
            memberId: member.id,
            conversationId: args.conversationId,
            conversationBudgetNanoUsd: facts.conversationBudgetNanoUsd,
            minTurnCostNanoUsd: turnMinCost(args.exposedCatalog, args.selection, {
              promptCharacterCount: args.promptCharacterCount,
              inputCharacterCount: args.inputCharacterCount,
            }),
          },
          args.now
        ).map((payer) => ({
          epochNumber: facts.epochNumber,
          walletId: payer.wallet.walletId,
          funding: payer.wallet.funding,
          // The sender the membership gate above just admitted, carried through
          // unchanged: the member row it resolved names the budget scope here,
          // and every later gate re-resolves it from this principal rather than
          // trusting a carried id.
          sender: args.sender,
          senderPrivilege: member.privilege,
          // Read off the chosen wallet, never re-derived from the sender: the
          // payer is by definition the account whose wallet this turn debits.
          payerUserId: payer.wallet.payerUserId,
          fundingDecisionInputs: payer.inputs,
        }))
      )
  );
}
