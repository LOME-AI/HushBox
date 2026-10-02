import { canSendMessages, pinnedSourceIds } from '@hushbox/shared';
import { findAdminDisabledModel, listDescriptors } from '../../../models/index.js';
import { okAsync } from '../../../../lib/result/index.js';
import { resolveTurnContext } from './context.js';
import { tierGateVerdict } from './tier-gate.js';
import type { MediaTurnBody, TurnPricingSelection } from './pricing.js';
import type { TierGateBody, TierGateRefusal } from './tier-gate.js';
import type { ResolveTurnContextDeps, TurnContext } from './context.js';
import type { ConversationCaller, ConversationsStores } from '../../../conversations/index.js';
import type {
  MemberPrivilege,
  ModelDescriptor,
  ReasoningEffortSelection,
  SenderPrincipal,
  TurnSourceList,
} from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';

/**
 * What the gated caller is about to do, which decides only whether a READ-only
 * member is admitted. Every other gate is identical, so the two routes share one
 * resolution rather than one growing a second.
 *
 * `send` — authoring a turn. Read-only is refused for every caller kind.
 *
 * `runControl` — stopping a run in flight. A session member keeps the latitude
 * it has always had here, because ARCHITECTURE §Streaming guarantees a user can
 * always stop a paid run they were able to start — and a member demoted to read
 * mid-run started one. A link guest still needs write: `send` refuses a read-only
 * guest, so it can never be stopping a run of its own, and a stop settles what
 * the run produced at the OWNER's expense.
 */
export type GatedCallerAction = 'send' | 'runControl';

/**
 * Whether the caller's resolved membership admits {@link GatedCallerAction}.
 * The single privilege rule behind both gated routes: no member row at all is
 * refused outright, and a read-only row is admitted only for a session member's
 * run control.
 *
 * It lives in domain rather than in the route because it COMPOSES a domain
 * rule — a member row a chat-domain read returned, the shared privilege
 * vocabulary and the resolved caller kind, assembled into a rule no slice
 * publishes. Composing a rule is what decides where a gate lives, whatever its
 * outcome carries; this one carries a boolean the route turns into a 403.
 *
 * The privilege arm asks {@link canSendMessages} rather than comparing against
 * `read`: the comparison agrees with it only while `read` is the sole privilege
 * below `write`, so a privilege inserted below `write` would have this admit a
 * send that {@link gatedTurnContext}'s own authorization gate refuses.
 */
export function memberAdmits(
  action: GatedCallerAction,
  caller: ConversationCaller,
  member: { readonly privilege: MemberPrivilege } | null
): boolean {
  if (member === null) return false;
  if (canSendMessages(member.privilege)) return true;
  return action === 'runControl' && caller.kind === 'user';
}

/**
 * What the gated resolution reads: the membership and wallet stores the freeze
 * needs, plus the catalog reader's own two dependencies.
 */
export interface GatedTurnContextDeps extends ResolveTurnContextDeps {
  readonly db: Database;
  readonly telemetry: Telemetry;
}

/**
 * The turn fields the gated resolution reads: the conversation and the optional
 * branch the turn runs on, plus the client's model selection.
 */
export interface GatedTurnRequest extends TierGateBody, MediaTurnBody {
  readonly conversationId: string;
  readonly forkId?: string | undefined;
  /**
   * Both feed the priced minimum: search prices each carrier's tool loop, `auto`
   * may buy a classifier.
   */
  readonly webSearchEnabled?: boolean | undefined;
  readonly reasoningEffort?: ReasoningEffortSelection | undefined;
}

/**
 * Whether a turn route enforces the premium-tier gate. The seam takes it as a
 * required argument rather than deriving it, because the exemption is a
 * product ruling and nothing in the request implies it: a new turn route is
 * forced to state its choice instead of silently inheriting one.
 *
 * `enforced` — the send paths. A caller funding a turn from their own wallet
 * with no purchased balance cannot select a premium model.
 *
 * `exemptModelAlreadyChosen` — the regenerate path, and only once the premise
 * has been CHECKED by {@link regenerateTierGateMode}. A re-run of a model the
 * replaced reply already used may run whatever its payer can afford: entitlement
 * was decided when that model was first chosen, and re-deciding it would strand a
 * caller on a reply they cannot re-run. A SUBSTITUTED model is a fresh
 * entitlement decision and takes `enforced` instead. ONLY entitlement is ever
 * exempt — every budget and affordability filter still applies in full, as does
 * the kill switch, because availability is not entitlement.
 */
export type PremiumTierGateMode = 'enforced' | 'exemptModelAlreadyChosen';

/**
 * What the regenerate's exemption premise is judged from: the anchor whose
 * replies this turn replaces, the single reply a retry-one names, and the
 * models the caller pinned.
 */
export interface RegenerateTierGateRequest {
  readonly conversationId: string;
  readonly targetMessageId: string;
  readonly replaceAssistantId?: string | undefined;
  readonly turnSources: TurnSourceList;
}

/**
 * Which {@link PremiumTierGateMode} a regenerate has earned, decided by testing
 * the exemption's own premise instead of assuming it: every model the caller
 * pinned must be one that produced content on a reply this regenerate replaces.
 * A retry-one is judged against the single reply it names — a sibling's model
 * was chosen for the sibling, not for the reply being replaced.
 *
 * An anchor with nothing to replace (no reply yet) leaves an empty set, so any
 * pinned model is a fresh choice and takes the send path's gate.
 *
 * It lives in domain rather than in the route because it COMPOSES a domain
 * rule: the reply-model rows are the conversations slice's, and the
 * set-membership test that turns them into an entitlement exemption is
 * published by no slice. Composing a rule is what decides where a gate lives,
 * whatever status its outcome carries — this one carries none at all, since its
 * answer is an input to {@link gatedTurnContext} rather than a refusal.
 */
export function regenerateTierGateMode(
  stores: ConversationsStores,
  request: RegenerateTierGateRequest
): ResultAsync<PremiumTierGateMode, DomainError> {
  return stores.messages
    .assistantReplyModels({
      conversationId: request.conversationId,
      parentMessageId: request.targetMessageId,
    })
    .map((replies) => {
      const replaced =
        request.replaceAssistantId === undefined
          ? replies
          : replies.filter((row) => row.messageId === request.replaceAssistantId);
      const alreadyChosen = new Set(replaced.map((row) => row.modelId));
      return pinnedSourceIds(request.turnSources).every((id) => alreadyChosen.has(id))
        ? 'exemptModelAlreadyChosen'
        : 'enforced';
    });
}

/**
 * Who is sending the turn, and which premium-tier gate mode it runs under — a
 * literal on the send paths, {@link regenerateTierGateMode}'s answer on the
 * regenerate. Both fields are required, so a new turn route states its gate
 * scope in the same breath as its sender rather than inheriting one by omission.
 */
export interface GatedTurnCaller {
  readonly sender: SenderPrincipal;
  readonly premiumTierGate: PremiumTierGateMode;
  /**
   * The prompt the turn will send, measured through the ONE shared counter —
   * the same number the turn budget carries. It is an argument rather than a
   * re-measurement because the minimum must be priced against the identical
   * prompt admission is budgeted against.
   */
  readonly promptCharacterCount: number;
  /**
   * The new user message inside it — the storage basis, and the same field the
   * turn budget stamps onto the definition. Zero on a re-run that stores no new
   * message, so the freeze reserves no storage the settlement will not charge.
   */
  readonly inputCharacterCount: number;
}

/**
 * Every way the gated resolution refuses a turn. `tier-locked` is carried in
 * from the tier gate's own union rather than restated, so a verdict added there
 * joins this one with no second edit — and the caller's status map stops
 * compiling until it answers for it.
 */
export type GatedTurnRefusal = 'send-forbidden' | 'model-disabled' | TierGateRefusal;

/**
 * What the gated resolution answers. The refusals are verdicts rather than
 * `DomainError`s because one funding question has several non-error outcomes the
 * caller must tell apart: a privilege refusal, an operator kill switch and an
 * entitlement lock each owe the caller their own wire code, and nothing failed
 * in producing any of them. Folding them into the error channel would put
 * ordinary answers where genuine failure lives, and hand the caller a code to
 * re-branch on in place of a map the compiler can see is total. The error
 * channel stays for what did fail — the reads this resolution performs.
 */
type GatedTurnOutcome =
  | { readonly kind: 'resolved'; readonly context: TurnContext }
  | { readonly kind: 'refused'; readonly refusal: GatedTurnRefusal };

/** The priced half of a request: the selection, with the routing identity dropped. */
function turnPricingSelection(body: GatedTurnRequest): TurnPricingSelection {
  return {
    turnSources: body.turnSources,
    modality: body.modality,
    imageConfig: body.imageConfig,
    videoConfig: body.videoConfig,
    webSearchEnabled: body.webSearchEnabled,
    reasoningEffort: body.reasoningEffort,
  };
}

/**
 * Whether the exposed snapshot accounts for every pinned model. Exposure
 * filters on `adminDisabledAt IS NULL`, so an id PRESENT in it cannot be
 * disabled; only an absent id needs the raw rows to tell "disabled" from
 * "unknown" apart, which is the only question the kill-switch gate answers.
 * The Smart slot pins no id, so it never sends the gate to the raw rows.
 */
function selectionFullyExposed(
  body: GatedTurnRequest,
  exposedCatalog: readonly ModelDescriptor[]
): boolean {
  const exposed = new Set(exposedCatalog.map((descriptor) => descriptor.id));
  return pinnedSourceIds(body.turnSources).every((id) => exposed.has(id));
}

/**
 * The admin kill switch, as a verdict. A disabled model already fails closed
 * downstream — it vanishes from the exposed catalog, so the turn build refuses
 * it as unknown — but that refusal is indistinguishable from a typo'd id. This
 * gate names the specific refusal for every id the client PINS by name. It
 * reads the RAW rows, which the exposed snapshot above cannot answer from, so
 * it is reached only when that snapshot does not already account for the whole
 * selection.
 */
function killSwitchVerdict(
  deps: GatedTurnContextDeps,
  body: GatedTurnRequest,
  exposedCatalog: readonly ModelDescriptor[]
): ResultAsync<GatedTurnOutcome | null, DomainError> {
  if (selectionFullyExposed(body, exposedCatalog)) return okAsync(null);
  return findAdminDisabledModel({ db: deps.db }, pinnedSourceIds(body.turnSources)).map(
    (disabled) => (disabled === undefined ? null : { kind: 'refused', refusal: 'model-disabled' })
  );
}

/**
 * The ONE seam a paid turn resolves its payer through, and therefore the one
 * place the model-selection gates are applied. The freeze and the gates live
 * together here, in domain, rather than composed by a route: a route able to
 * obtain a context without them ships a silent bypass, which is how the guest
 * send came to accept a premium model from a free-tier sender. The freeze is
 * not published on the slice barrel, so no route and no other slice can reach
 * it, and the `paid-turn-routes-prove-payer-seam` architecture rule holds it to
 * one call site — {@link gatedTurnContext}'s. The ordering cannot be forgotten
 * because there is nowhere else to assemble it.
 *
 * The order is authorization, then availability, then entitlement, and each
 * step's refusal is the one the caller owes: a read-only member is refused on
 * their privilege whatever they selected, a selection carrying both a disabled
 * model and a premium one answers the specific kill-switch refusal, and only a
 * caller past both meets the tier gate.
 *
 * ONE exposed-catalog read serves the freeze and the tier gate: the snapshot
 * that prices the payer freeze is the snapshot the tier gate classifies
 * against, where two reads could straddle an hourly refresh and decide one
 * funding outcome on two different catalogs. The kill switch's read is a
 * different question and stays its own.
 */
export function gatedTurnContext(
  deps: GatedTurnContextDeps,
  body: GatedTurnRequest,
  caller: GatedTurnCaller,
  now: Date
): ResultAsync<GatedTurnOutcome, DomainError> {
  return listDescriptors({ db: deps.db, telemetry: deps.telemetry }).andThen((exposedCatalog) =>
    resolveTurnContext({ conversations: deps.conversations, billing: deps.billing }, deps.db, {
      conversationId: body.conversationId,
      sender: caller.sender,
      forkId: body.forkId,
      now,
      exposedCatalog,
      selection: turnPricingSelection(body),
      promptCharacterCount: caller.promptCharacterCount,
      inputCharacterCount: caller.inputCharacterCount,
    }).andThen((context) => {
      // Authorization first: a read-only member may see the conversation but
      // never spend against it, so the refusal names the caller's privilege
      // rather than whatever the selection happens to carry. It sits above
      // every other gate and above run start, so no admission hold is placed
      // and no provider is reached.
      if (!canSendMessages(context.senderPrivilege)) {
        return okAsync<GatedTurnOutcome, DomainError>({
          kind: 'refused',
          refusal: 'send-forbidden',
        });
      }
      return killSwitchVerdict(deps, body, exposedCatalog).map((disabled): GatedTurnOutcome => {
        if (disabled !== null) return disabled;
        // Entitlement last, and decided against the payer the context froze, so
        // it follows the PAYER — an owner-funded turn is exempt whatever the
        // sender could afford personally. A route that has already checked the
        // re-run exemption's premise skips it and keeps the context.
        if (caller.premiumTierGate === 'exemptModelAlreadyChosen') {
          return { kind: 'resolved', context };
        }
        const verdict = tierGateVerdict(
          exposedCatalog,
          body,
          context.fundingDecisionInputs,
          now.getTime()
        );
        return verdict === 'allowed'
          ? { kind: 'resolved', context }
          : { kind: 'refused', refusal: verdict };
      });
    })
  );
}
