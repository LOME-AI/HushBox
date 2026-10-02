import { ERROR_CODES } from '@hushbox/shared';
import { respondDomainError } from '../../../middleware/pipeline-manifest.js';
import { createErrorResponse, gatedTurnContext, regenerateTierGateMode } from '../domain/index.js';
import type { Context } from 'hono';
import type { ChatHistoryMessage, ErrorCode } from '@hushbox/shared';
import type { RunStartBody } from '@hushbox/realtime';
import type {
  GatedTurnCaller,
  GatedTurnRefusal,
  GatedTurnRequest,
  MultiModelTurnBuild,
  PremiumTierGateMode,
  RegenerateTierGateRequest,
} from '../domain/index.js';
import type {
  AppEnv,
  RefusalResponse,
  RefusalStatus,
} from '../../../middleware/pipeline-manifest.js';
import type { ChatRouteDeps, TurnContext } from '../domain/index.js';

/**
 * The regenerate's premium-tier exemption, as HTTP: it decides nothing.
 * {@link regenerateTierGateMode} tests the exemption's premise, in domain; this
 * half supplies the store and translates a failed read.
 */
export async function regeneratePremiumTierGate(
  c: Context<AppEnv>,
  deps: ChatRouteDeps,
  body: RegenerateTierGateRequest
): Promise<PremiumTierGateMode | RefusalResponse> {
  const mode = await regenerateTierGateMode(deps.conversations(c.var.db), body);
  return mode.isErr() ? respondDomainError(c, mode.error) : mode.value;
}

/**
 * The wire refusal each refusing verdict owes the caller. It is a total map over
 * {@link GatedTurnRefusal}, not a partial lookup: a verdict added to that union
 * with no row here does not compile, so a refusal cannot reach the client as
 * whatever a fallthrough happened to answer.
 */
const GATED_TURN_REFUSAL = {
  'send-forbidden': [ERROR_CODES.FORBIDDEN, 403],
  'model-disabled': [ERROR_CODES.MODEL_DISABLED, 403],
  'tier-locked': [ERROR_CODES.MODEL_TIER_LOCKED, 403],
} as const satisfies Record<GatedTurnRefusal, readonly [ErrorCode, RefusalStatus]>;

/**
 * The paid turn's payer resolution, as HTTP: it decides nothing. The freeze and
 * the model-selection gates are {@link gatedTurnContext}, in domain, which is
 * the only door to a turn context — the freeze is unpublished, so a route
 * cannot assemble one with a gate left out. Returns the refusal response, or
 * the resolved context.
 */
export async function resolveGatedTurnContext(
  c: Context<AppEnv>,
  deps: ChatRouteDeps,
  body: GatedTurnRequest,
  caller: GatedTurnCaller
): Promise<RefusalResponse | TurnContext> {
  const outcome = await gatedTurnContext(
    {
      db: c.var.db,
      telemetry: c.var.logger,
      conversations: deps.conversations,
      billing: deps.billing,
    },
    body,
    caller,
    new Date()
  );
  if (outcome.isErr()) return respondDomainError(c, outcome.error);
  if (outcome.value.kind === 'resolved') return outcome.value.context;
  const [code, status] = GATED_TURN_REFUSAL[outcome.value.refusal];
  return c.json(createErrorResponse(code), status);
}

/**
 * The re-run block, carried only when the turn supersedes an existing reply.
 * Named off the wire schema so a field added there reaches every paid route
 * through one signature.
 */
type PaidRunRegenerate = Extract<RunStartBody, { readonly mode: 'paid' }>['regenerate'];

/** The client-intent fields every paid route contributes to the run body. */
interface PaidRunRequest {
  readonly userMessage: { readonly content: string };
  readonly forkId?: string | undefined;
  readonly customInstructions?: string | undefined;
}

/** What a paid route resolved before it can hand the run to the DO. */
export interface PaidRun {
  readonly body: PaidRunRequest;
  readonly runKey: string;
  readonly bodyHash: string;
  readonly definition: MultiModelTurnBuild;
  readonly history: ChatHistoryMessage[];
  readonly context: TurnContext;
  /**
   * The id of the turn's user message: one the route mints for a send or an
   * edit, or the anchor's id for a retry, which stores no new user row.
   */
  readonly userMessageId: string;
  readonly regenerate?: PaidRunRegenerate;
}
