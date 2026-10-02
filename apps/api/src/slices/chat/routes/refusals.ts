import { DOMAIN_ERROR_CODE_TO_WIRE_CODE, ERROR_CODES, pinnedSourceIds } from '@hushbox/shared';
import {
  STATUS_BY_DOMAIN_CODE,
  respondDomainError,
} from '../../../middleware/pipeline-manifest.js';
import {
  consumeChatStreamUserLimit,
  consumeTrialSendIpLimit,
  createErrorResponse,
  findAdminDisabledModel,
  trialGateVerdict,
} from '../domain/index.js';
import type { Context } from 'hono';
import type {
  ErrorCode,
  ModelDescriptor,
  RunAttachResponse,
  RunStartedResponse,
  TurnSourceList,
} from '@hushbox/shared';
import type { TrialGateRefusal } from '../domain/index.js';
import type {
  AppEnv,
  RefusalResponse,
  RefusalStatus,
} from '../../../middleware/pipeline-manifest.js';
import type { ChatRouteDeps, DomainErrorCode, RegenerateDecision } from '../domain/index.js';

/**
 * Maps a non-`allowed` regenerate verdict to its rejection response, or null to
 * proceed to admission. `invalid-replace` (the retry-one target is not a real
 * assistant reply of the anchor) shares the 404 with a missing target; both are
 * authorization gates that keep the settlement's delete from touching an
 * arbitrary message. `fork-required` (409) refuses a no-forkId regenerate once
 * the conversation has forks (the linear sequence-delete would cross branches);
 * `blocked` (403) is the cross-member intervening-message refusal.
 */
export function regenerateRejection(
  c: Context<AppEnv>,
  decision: RegenerateDecision
): RefusalResponse | null {
  switch (decision) {
    case 'target-missing':
    case 'invalid-replace': {
      return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
    }
    case 'fork-required': {
      return c.json(createErrorResponse(ERROR_CODES.FORK_ID_REQUIRED), 409);
    }
    case 'blocked': {
      return c.json(createErrorResponse(ERROR_CODES.REGENERATION_BLOCKED_BY_OTHER_USER), 403);
    }
    case 'allowed': {
      return null;
    }
  }
}

/**
 * The wire refusal each refusing trial verdict owes the caller. Total over
 * {@link TrialGateRefusal}, not a partial lookup: a verdict added to that union
 * with no row here does not compile, so a refusal cannot reach the client as
 * whatever a fallthrough happened to answer.
 */
const TRIAL_GATE_REFUSAL = {
  'media-blocked': [ERROR_CODES.MEDIA_TRIAL_BLOCKED, 403],
  'premium-required': [ERROR_CODES.PREMIUM_REQUIRES_ACCOUNT, 403],
  'too-expensive': [ERROR_CODES.TRIAL_MESSAGE_TOO_EXPENSIVE, 402],
} as const satisfies Record<TrialGateRefusal, readonly [ErrorCode, RefusalStatus]>;

/**
 * The trial send's MODEL/AFFORDABILITY gate, as HTTP: it decides nothing.
 * {@link trialGateVerdict} is the gate, in domain. This half runs before the
 * quota INCR (a refusal burns no slot) and before the turn compile, and it is
 * the only producer of MEDIA_TRIAL_BLOCKED: the compile's accept-or-refuse
 * answer does not move with a model's one output modality, so it never
 * re-makes this refusal — and a media target never gets that far, because this
 * gate returns and no later leg of the trial build runs. The typed 400
 * `trialReasoningOrRefusal` (`trial-definition.ts`) answers a PINNED effort level with is a
 * different refusal on a different input: a TEXT model this gate allows whose
 * descriptor offers no such level. A media send never meets it.
 * Returns the refusal response, or null to proceed.
 */
export function trialGateRejection(
  c: Context<AppEnv>,
  target: ModelDescriptor | undefined,
  exposedCatalog: readonly ModelDescriptor[],
  promptCharacterCount: number
): RefusalResponse | null {
  const verdict = trialGateVerdict(target, exposedCatalog, promptCharacterCount, Date.now());
  if (verdict.isErr()) return respondDomainError(c, verdict.error);
  if (verdict.value === 'allowed') return null;
  const [code, status] = TRIAL_GATE_REFUSAL[verdict.value];
  return c.json(createErrorResponse(code), status);
}

/**
 * Resolves a reserved rate-limit decision to a refusal response, or null to
 * proceed. Redis down fails closed (503 via the typed `unavailable` error);
 * an over-cap reservation answers RATE_LIMITED (429) with its retry window.
 */
export async function rateLimitRejection(
  c: Context<AppEnv>,
  reserve: ReturnType<typeof consumeChatStreamUserLimit>
): Promise<RefusalResponse | null> {
  const decision = await reserve;
  if (decision.isErr()) return respondDomainError(c, decision.error);
  if (decision.value.allowed) return null;
  return c.json(
    createErrorResponse(ERROR_CODES.RATE_LIMITED, {
      retryAfterSeconds: decision.value.retryAfterSeconds,
    }),
    429
  );
}

/**
 * The paid send's per-caller rate limit for the GUEST send path only: the key
 * is the resolved sender principal — a linkId for a link guest, the account id
 * for a session holder, since that route admits both — and no linkId is
 * derivable at the edge, so the whole route counts here. `/chat` and
 * `/chat/regenerate` declare the same registry entry as a pipeline-counted
 * layer in this slice's posture fragment instead.
 */
export function chatUserRateLimitRejection(
  c: Context<AppEnv>,
  userId: string
): Promise<RefusalResponse | null> {
  return rateLimitRejection(c, consumeChatStreamUserLimit(c.var.redis, userId));
}

/**
 * The trial send's two refusals that precede every Postgres read: the per-IP
 * abuse throttle, then the admin kill switch whose catalog read is the work the
 * throttle exists to bound. Ordering is the whole point — the kill switch
 * refuses without consuming quota by design, so an anonymous caller naming a
 * disabled model would otherwise buy a query per request indefinitely.
 */
export async function trialPreWorkRejection(
  c: Context<AppEnv>,
  body: { readonly turnSources: TurnSourceList },
  ipHash: string
): Promise<RefusalResponse | null> {
  const throttled = await rateLimitRejection(c, consumeTrialSendIpLimit(c.var.redis, ipHash));
  if (throttled !== null) return throttled;
  return disabledModelRejection(c, body);
}

/**
 * The admission hook projects every non-`unavailable` `DomainError` it meets
 * onto `domainWireCode(error)`, so those refusals reach the run-start lookup as
 * plain taxonomy wire codes and owe the caller exactly what
 * `respondDomainError` gives the same error. Derived from the one status map
 * rather than transcribed beside it: a new taxonomy member arrives here with
 * its status already decided, and the two can never disagree.
 */
function taxonomyRefusalStatuses(): Partial<Record<ErrorCode, RefusalStatus>> {
  const entries = Object.entries(STATUS_BY_DOMAIN_CODE) as readonly (readonly [
    DomainErrorCode,
    RefusalStatus,
  ])[];
  return Object.fromEntries(
    entries.map(([code, status]) => [DOMAIN_ERROR_CODE_TO_WIRE_CODE[code], status])
  );
}

/**
 * The HTTP status for each typed run-start refusal. Admission refusals are
 * SYNCHRONOUS HTTP answers (founder ruling), not only run-failed WS events.
 *
 * A code with no row falls through to the 409 below, which has silently turned
 * a payable refusal into a conflict more than once; the enumeration over this
 * table walks each producer the room can answer from, so a new refusal code
 * cannot inherit that default unnoticed.
 */
export const RUN_REFUSAL_STATUS: Partial<Record<ErrorCode, RefusalStatus>> = {
  ...taxonomyRefusalStatuses(),
  [ERROR_CODES.CONCURRENT_RUN]: 409,
  [ERROR_CODES.IDEMPOTENCY_BODY_MISMATCH]: 409,
  // A live claim on the same key is a conflict rather than a payment problem,
  // which is what the fallthrough would have said anyway — spelled out so the
  // status is decided rather than inherited.
  [ERROR_CODES.REQUEST_IN_PROGRESS]: 409,
  [ERROR_CODES.INSUFFICIENT_ADMISSION]: 402,
  // The run cap is a distinct CONDITION with its own copy, but the same
  // refusal class and therefore the same status the collapsed code answered:
  // splitting the wording must not silently move a client's status handling.
  [ERROR_CODES.RUN_CAPACITY_REACHED]: 402,
  // A spent daily allowance and a spent group allocation are the same refusal
  // class as an empty balance — payable conditions on a turn the wallet could
  // otherwise fund — so they keep that class's status even though each carries
  // its own copy and its own remedy.
  [ERROR_CODES.DAILY_ALLOWANCE_EXHAUSTED]: 402,
  [ERROR_CODES.GROUP_ALLOCATION_EXHAUSTED]: 402,
  [ERROR_CODES.ADMISSION_UNAVAILABLE]: 503,
  [ERROR_CODES.TRIAL_CAPACITY_REACHED]: 429,
  // The engine's post-`done` backstop settles the admission promise with
  // INTERNAL when a defect escapes before the decision. A defect is a 500; as a
  // 409 it read as a conflict the client could usefully retry.
  [ERROR_CODES.INTERNAL]: 500,
};

/** The realtime port's run-start outcome, as this route observes it structurally. */
type RunStartOutcome = Parameters<
  Parameters<ReturnType<ReturnType<ChatRouteDeps['realtime']>['startRun']>['match']>[0]
>[0];

/**
 * The run-start outcomes that are NOT a fresh start: a settled/duplicate key
 * replays the persisted response (never a transport error), a still-live run
 * tells the client to rejoin its stream, and a refusal maps to its status.
 *
 * The fresh-run 201 is deliberately NOT answered here, and the exclusion is
 * load-bearing rather than tidiness: each caller's fresh-run body differs (the
 * trial adds `trialSessionId` to the paid `{ runId, deadlineAt }`), and a single
 * return union carrying both 201 shapes is subtype-reduced by TypeScript onto
 * `{ runId, deadlineAt }` — erasing `trialSessionId` from `AppType` while the
 * runtime body still carries it. Keeping the 201 at the call site keeps each
 * route's union free of a second 201 member for the reduction to collapse.
 */
function respondNonStarted(
  c: Context<AppEnv>,
  outcome: Exclude<RunStartOutcome, { readonly started: true }>
) {
  if ('outcome' in outcome) {
    return outcome.outcome === 'replay'
      ? c.json(outcome.response, 200)
      : c.json(
          {
            outcome: 'attach',
            userMessageId: outcome.userMessageId,
            assistantMessageIds:
              outcome.assistantMessageIds === null ? null : [...outcome.assistantMessageIds],
          } satisfies RunAttachResponse,
          200
        );
  }
  return c.json(createErrorResponse(outcome.code), RUN_REFUSAL_STATUS[outcome.code] ?? 409);
}

/**
 * The paid turn routes' run-start response: a fresh run handle is the shared
 * {@link RunStartedResponse} body. `userMessageId` is the turn's user message id
 * as the route handed it to the room: the id it minted for a send or an edit, or
 * a retry's anchor id, since a retry stores no new user row. `assistantMessageIds`
 * are the ids the room minted for the answers, in the selected order, which
 * settlement stores them under. The return type is inferred so the response
 * shapes still flow into `AppType`.
 */
export function respondRunStart(
  c: Context<AppEnv>,
  started: ReturnType<ReturnType<ChatRouteDeps['realtime']>['startRun']>,
  userMessageId: string
) {
  return started.match(
    (outcome) =>
      !('outcome' in outcome) && outcome.started
        ? c.json(
            {
              runId: outcome.runId,
              deadlineAt: outcome.deadlineAt,
              userMessageId,
              // Copied into a mutable array: the typed client infers a
              // readonly array's elements as `never`.
              assistantMessageIds: [...outcome.assistantMessageIds],
            } satisfies RunStartedResponse,
            201
          )
        : respondNonStarted(c, outcome),
    (error) => respondDomainError(c, error)
  );
}

/**
 * The trial route's run-start response: the fresh-run 201 additionally carries
 * the minted `trialSessionId` so a tokenless client learns its room and can
 * store it as `x-trial-token` — the WS upgrade then resolves the same room and
 * same-key retries replay/attach. Every other outcome matches the paid contract.
 */
export function respondTrialRunStart(
  c: Context<AppEnv>,
  started: ReturnType<ReturnType<ChatRouteDeps['realtime']>['startRun']>,
  trialSessionId: string
) {
  return started.match(
    (outcome) =>
      !('outcome' in outcome) && outcome.started
        ? c.json({ runId: outcome.runId, deadlineAt: outcome.deadlineAt, trialSessionId }, 201)
        : respondNonStarted(c, outcome),
    (error) => respondDomainError(c, error)
  );
}

/**
 * The TRIAL send's admin kill-switch gate (the MODEL_TIER_LOCKED pattern): a
 * disabled model already fails closed downstream — it vanishes from the exposed
 * catalog, so the turn build refuses it as unknown — but that refusal is
 * indistinguishable from a typo'd id. This gate names the specific
 * MODEL_DISABLED refusal for every id the client PINS by name. The Smart slot
 * pins none and is not judged: its candidates are derived from the exposed
 * catalog, which never contains a disabled model. The paid paths reach the same
 * kill switch inside `gatedTurnContext` (the domain barrel), which orders it against the
 * gates a trial send does not have.
 *
 * It reads the RAW rows, because a disabled model is invisible through every
 * exposed read.
 */
async function disabledModelRejection(
  c: Context<AppEnv>,
  body: { readonly turnSources: TurnSourceList }
): Promise<RefusalResponse | null> {
  const disabled = await findAdminDisabledModel(
    { db: c.var.db },
    pinnedSourceIds(body.turnSources)
  );
  if (disabled.isErr()) return respondDomainError(c, disabled.error);
  if (disabled.value === undefined) return null;
  return c.json(createErrorResponse(ERROR_CODES.MODEL_DISABLED), 403);
}
