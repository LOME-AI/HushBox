// The searching turn's money path on the local stack: the chat route builds the
// run, the conversation runtime the room composes executes it against the mock
// provider and its fake search backend, and the real settlement persists and
// bills it. Models are seeded under {@link WEB_SEARCH_MODEL_PREFIX}: this file's
// beforeAll purges any row under it left in the slot, and the shared setup's
// afterAll deletes what this file seeded.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import {
  decryptContentEnvelope,
  generateEpochKeyPair,
  unwrapContentKeyFromEpoch,
} from '@hushbox/crypto';
import {
  contentItems,
  conversationMembers,
  epochMembers,
  epochs,
  ledgerEntries,
  llmCompletions,
  messages,
  modelCatalog,
  usageRecords,
  wallets,
} from '@hushbox/db';
import {
  ASSISTANT_FRAMING_MAX_CHARS,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  ModelDescriptor,
  ResolvedReasoningEffort,
  SEGMENT_SPECS,
  parseAssistantMessage,
  serializeSegments,
} from '@hushbox/shared';
import {
  TOOL_DECLARATIONS,
  charStorageNanoUsd,
  inputTokensOf,
  toolCallBillableNano,
  toolCallCapFor,
  toolCallChargeNanoUsd,
  toolLoopBound,
  toolLoopStepsFor,
} from '@hushbox/shared/affordability';
import { runStartBodySchema } from '@hushbox/realtime/protocol';
import { okAsync } from '../../lib/result/index.js';
import { providerUsdToBillableNanoUsd } from '../billing/index.js';
import { MOCK_ECHO_AFFIXES, MOCK_GENERATION_COST_USD } from '../models/index.js';
import { MOCK_REASONING_TEXT } from '../models/adapters/mock-provider.js';
import { createFakeSearchProvider } from '../models/adapters/fake-search-provider.js';
import {
  BYTES,
  STARTED,
  WEB_SEARCH_MODEL_PREFIX,
  cookie,
  createdConversationIds,
  db,
  fakeRealtime,
  post,
  redis,
  seedGateModel,
  seedUser,
  testEnv,
} from '../../test-support/chat-routes.integration.setup.js';
import { seedConversationWithEpoch } from '../../test-support/conversation-seed.js';
import { createChatConversationRuntime } from './conversation-runtime.js';
import { CHAT_CLASSIFIER_NODE_ID } from './domain/turn/classifier.js';
import { ASSISTANT_SENDER_ID } from './domain/settlement/settlement.js';
import type { WrappedSecret } from '@hushbox/crypto';
import type {
  FlowRunOutcome,
  InferenceEvent,
  InferenceRequest,
  PaidRunIdentity,
  RunContext,
  Segment,
  StorageStamp,
  WebSearchEntry,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { RunStartBody } from '@hushbox/realtime/protocol';
import type { ModelProvider } from '../models/index.js';
import type { EpochPublicKeyReader } from './domain/settlement/settlement.js';
import type { Telemetry } from '../../lib/telemetry/index.js';

/**
 * Every request the run's model provider is asked to serve, recorded at the
 * gateway seam and passed through unchanged, so a test can read the output
 * ceiling a call actually ran at.
 */
const gateway = vi.hoisted((): { requests: InferenceRequest[] } => ({ requests: [] }));

vi.mock('../models/adapters/mock-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../models/adapters/mock-provider.js')>();
  return {
    ...actual,
    createMockModelProvider: (
      ...args: Parameters<typeof actual.createMockModelProvider>
    ): ModelProvider => {
      const provider = actual.createMockModelProvider(...args);
      return {
        infer: (request, descriptor, options) => {
          gateway.requests.push(request);
          return provider.infer(request, descriptor, options);
        },
      };
    },
  };
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the web search billing suite`);
  }
  return value;
}

/** The room's own composition reads its storage from these bindings. */
const runtimeEnv = {
  ...testEnv,
  R2_S3_ENDPOINT: requireEnv('R2_S3_ENDPOINT'),
  R2_BUCKET_MEDIA: requireEnv('R2_BUCKET_MEDIA'),
  R2_ACCESS_KEY_ID: requireEnv('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: requireEnv('R2_SECRET_ACCESS_KEY'),
};

const readEpochPublicKey: EpochPublicKeyReader = async (tx, conversationId, epochNumber) => {
  const rows = await tx
    .select({ key: epochs.epochPublicKey })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
  return rows[0]?.key ?? null;
};

function telemetry(): Telemetry {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    captureError: vi.fn(),
  };
}

const PROMPT = 'What changed in the search billing?';
/** Ample: every rung is funded and every rung's ceiling is the model's own output cap. */
const AMPLE_NANO_USD = 10_000_000_000n;
/**
 * Short of every rung's cap: each rung's own budget solve buys a different
 * ceiling, so a call that ran at a rung other than the decided one shows.
 */
const TIGHT_NANO_USD = 100_000_000n;
const decoder = new TextDecoder();

beforeAll(async () => {
  await db.delete(modelCatalog).where(like(modelCatalog.modelId, `${WEB_SEARCH_MODEL_PREFIX}%`));
});

/** A cheap tool-capable model with the full effort ladder, as ingestion would mint it. */
async function seedSearchModel(): Promise<string> {
  const model = `${WEB_SEARCH_MODEL_PREFIX}/billing-${crypto.randomUUID().slice(0, 8)}`;
  await seedGateModel(model, {
    behaviors: ['streaming', 'tools'],
    reasoning: { supportedEfforts: null },
    limits: { contextLength: 1_000_000 },
  });
  return model;
}

interface Payer {
  readonly userId: string;
  readonly walletId: string;
  readonly conversationId: string;
  readonly epochPrivateKey: ReturnType<typeof generateEpochKeyPair>['privateKey'];
}

/** A member of a conversation whose epoch key the test holds, paying from its own wallet. */
async function seedPayer(balanceNanoUsd: bigint): Promise<Payer> {
  const userId = await seedUser();
  const walletRows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased', balanceNanoUsd })
    .returning({ id: wallets.id });
  const walletId = walletRows[0]?.id;
  if (walletId === undefined) throw new Error('wallet seed failed');
  const keyPair = generateEpochKeyPair();
  const { conversationId, epochId } = await seedConversationWithEpoch(db, {
    userId,
    title: BYTES,
    epochPublicKey: keyPair.publicKey,
  });
  createdConversationIds.push(conversationId);
  await db.insert(epochMembers).values({
    epochId,
    memberPublicKey: BYTES,
    wrap: BYTES,
    visibleFromEpoch: 1,
  });
  await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });
  return { userId, walletId, conversationId, epochPrivateKey: keyPair.privateKey };
}

type PaidRunStartBody = Extract<RunStartBody, { mode: 'paid' }>;

/** The run-start body a 201 searching send hands the room, parsed as the room parses it. */
async function sendSearchTurn(
  payer: Payer,
  model: string,
  reasoningEffort: string,
  headers: Record<string, string>
): Promise<PaidRunStartBody> {
  // The Worker hands the room its body as JSON, so it crosses as text here too.
  const wire: string[] = [];
  const realtime = fakeRealtime(STARTED, {
    startRun: (_conversationId, body) => {
      wire.push(JSON.stringify(body));
      return okAsync(STARTED);
    },
  });
  const res = await post(
    realtime,
    { cookie: await cookie(payer.userId), 'Idempotency-Key': crypto.randomUUID(), ...headers },
    {
      conversationId: payer.conversationId,
      turnSources: [{ kind: 'model', id: model }],
      webSearchEnabled: true,
      reasoningEffort,
      userMessage: { content: PROMPT },
    }
  );
  expect(res.status).toBe(201);
  const sent = wire[0];
  if (sent === undefined) throw new Error('expected the route to start a run');
  const body = runStartBodySchema.parse(JSON.parse(sent));
  if (body.mode !== 'paid') throw new Error('expected a paid run-start body');
  return body;
}

interface ExecutedTurn {
  readonly definition: WorkflowDefinition;
  readonly runId: string;
  /** What admission was asked to hold for the run. */
  readonly holdNanoUsd: bigint;
  readonly outcome: FlowRunOutcome;
  readonly events: readonly InferenceEvent[];
  readonly requests: readonly InferenceRequest[];
}

/**
 * Runs a captured body the way the room's `startRun` does: claim the referee,
 * bind the hooks over the run context, start the executor.
 */
async function executeInRoom(body: PaidRunStartBody, payer: Payer): Promise<ExecutedTurn> {
  const runtime = createChatConversationRuntime({
    env: runtimeEnv,
    db,
    redis,
    telemetry: telemetry(),
    readEpochPublicKey,
  });
  const runId = crypto.randomUUID();
  const identity: PaidRunIdentity = {
    mode: 'paid',
    payerUserId: body.userId,
    sender: body.sender,
    conversationId: payer.conversationId,
    walletId: body.walletId,
    epochNumber: body.epochNumber,
    userMessage: body.userMessage,
  };
  const claim = await runtime.claimRun({
    runKey: body.runKey,
    runId,
    bodyHash: body.bodyHash,
    identity,
  });
  if (claim.outcome !== 'executor') throw new Error(`expected an executor claim: ${claim.outcome}`);
  const context: RunContext = {
    ...identity,
    runId,
    fence: claim.fence,
    ...(body.mockDirectives === undefined ? {} : { mockDirectives: body.mockDirectives }),
  };
  const hooks = runtime.bindHooks(context, body.definition);
  const holds: bigint[] = [];
  const events: InferenceEvent[] = [];
  const requestsBefore = gateway.requests.length;
  const handle = runtime.executor.start({
    definition: body.definition,
    inputs: body.inputs,
    history: body.history,
    hooks: {
      ...hooks,
      admission: (request) => {
        holds.push(request.estimate);
        return hooks.admission(request);
      },
    },
    runKey: body.runKey,
    runId,
    ...(body.mockDirectives === undefined ? {} : { mockDirectives: body.mockDirectives }),
    emit: (frame) => {
      events.push(frame.event);
    },
  });
  const outcome = await handle.done;
  const holdNanoUsd = holds[0];
  if (holdNanoUsd === undefined) throw new Error('admission was never asked to hold');
  return {
    definition: body.definition,
    runId,
    holdNanoUsd,
    outcome,
    events,
    requests: gateway.requests.slice(requestsBefore),
  };
}

type ModelCallNode = Extract<WorkflowDefinition['nodes'][number], { type: 'modelCall' }>;

function searchingAnswer(definition: WorkflowDefinition): ModelCallNode {
  const answer = definition.nodes.find(
    (node): node is ModelCallNode => node.type === 'modelCall' && node.tools.length > 0
  );
  if (answer === undefined) throw new Error('expected a searching answer node');
  return answer;
}

function declaredCeiling(node: ModelCallNode): number {
  const ceiling = node.params['maxOutputTokens'];
  if (typeof ceiling !== 'number') throw new TypeError('expected a declared output ceiling');
  return ceiling;
}

interface HeldRates {
  readonly inputPerToken: bigint;
  readonly outputPerToken: bigint;
}

/** Five quarters of a stored rate, rounded up: what a hold reserves one token at. */
function heldRate(storedRate: bigint): bigint {
  return (storedRate * 5n + 3n) / 4n;
}

/** The token rates a hold reserves the model at, from the stored rates on its catalog row. */
async function heldRates(model: string): Promise<HeldRates> {
  const rows = await db
    .select({ descriptor: modelCatalog.descriptor })
    .from(modelCatalog)
    .where(eq(modelCatalog.modelId, model));
  const { pricing } = ModelDescriptor.parse(rows[0]?.descriptor);
  if (pricing.kind !== 'tokens') throw new TypeError('expected stored token rates');
  const { base } = pricing.anchor;
  return { inputPerToken: heldRate(base.input), outputPerToken: heldRate(base.output) };
}

interface LoopHoldTerms {
  readonly prompt: bigint;
  readonly output: bigint;
  readonly outputStorage: bigint;
  readonly ownOutputResent: bigint;
  readonly resultsResent: bigint;
  readonly toolUseOverhead: bigint;
  readonly toolFees: bigint;
  readonly recordStorage: bigint;
  readonly framing: bigint;
}

/** The storage one output token reserves: 5 stored characters at 300 nano. */
const OUTPUT_STORAGE_NANO_PER_TOKEN = 1500n;

/**
 * The tool-loop hold for one tool-carrying node, written out term by term: C
 * calls, S = C + 1 steps, per-step ceiling c, prompt p tokens.
 */
function loopHoldTerms(
  loop: { readonly calls: number; readonly ceiling: number; readonly promptTokens: number },
  rates: HeldRates
): LoopHoldTerms {
  const C = BigInt(loop.calls);
  const S = C + 1n;
  const c = BigInt(loop.ceiling);
  const p = BigInt(loop.promptTokens);
  const search = TOOL_DECLARATIONS.webSearch;
  const r = BigInt(inputTokensOf(search.resultMaxChars));
  return {
    prompt: S * p * rates.inputPerToken,
    output: S * c * rates.outputPerToken,
    outputStorage: S * c * OUTPUT_STORAGE_NANO_PER_TOKEN,
    ownOutputResent: ((S * (S - 1n)) / 2n) * c * rates.inputPerToken,
    resultsResent: C * (S - 1n) * r * rates.inputPerToken,
    toolUseOverhead:
      (S - 1n) * BigInt(toolLoopBound(['webSearch'], 1).overheadTokens) * rates.inputPerToken,
    toolFees: C * toolCallBillableNano('webSearch'),
    recordStorage: charStorageNanoUsd(SEGMENT_SPECS[search.recordKind].storageAllowanceChars),
    framing: charStorageNanoUsd(ASSISTANT_FRAMING_MAX_CHARS),
  };
}

function sumTerms(terms: LoopHoldTerms): bigint {
  return Object.values(terms).reduce((total: bigint, term: bigint) => total + term, 0n);
}

function storageStamp(definition: WorkflowDefinition): StorageStamp {
  const stamp = definition.storage;
  if (stamp === undefined) throw new Error('expected a storage stamp on a persisting turn');
  return stamp;
}

function promptTokens(node: ModelCallNode): number {
  if (node.promptInputTokens === undefined) throw new Error('expected a stamped prompt');
  return node.promptInputTokens;
}

/** The node's hold at one rung: that rung's loop at the given ceiling, plus input storage once. */
async function rungHold(
  definition: WorkflowDefinition,
  node: ModelCallNode,
  rung: ResolvedReasoningEffort,
  ceiling: number
): Promise<{ terms: LoopHoldTerms; inputStorage: bigint; total: bigint }> {
  const stamp = storageStamp(definition);
  const terms = loopHoldTerms(
    { calls: toolCallCapFor(rung), ceiling, promptTokens: promptTokens(node) },
    await heldRates(node.model)
  );
  const inputStorage = charStorageNanoUsd(stamp.inputChars);
  return { terms, inputStorage, total: sumTerms(terms) + inputStorage };
}

interface PersistedAnswer {
  readonly text: string;
  readonly contentItemId: string;
  readonly displayCostNanoUsd: bigint | null;
}

/** The run's assistant text, decrypted with the conversation's epoch key. */
async function persistedAnswer(payer: Payer): Promise<PersistedAnswer> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(eq(messages.conversationId, payer.conversationId), eq(messages.senderType, 'assistant'))
    );
  const message = rows[0];
  if (message?.wrappedContentKey == null) throw new Error('expected one stored assistant message');
  const items = await db.select().from(contentItems).where(eq(contentItems.messageId, message.id));
  const item = items[0];
  if (item?.encryptedBlob == null) throw new Error('expected a stored assistant text');
  // Stored bytes carry no brand; this column holds exactly the wrap settlement wrote.
  const wrapped = message.wrappedContentKey as WrappedSecret;
  const plaintext = decryptContentEnvelope(
    unwrapContentKeyFromEpoch(payer.epochPrivateKey, wrapped),
    wrapped,
    {
      conversationId: payer.conversationId,
      messageId: message.id,
      contentItemId: item.id,
      position: 0,
      epochNumber: 1,
      senderId: ASSISTANT_SENDER_ID,
    },
    item.encryptedBlob
  );
  return {
    text: decoder.decode(plaintext),
    contentItemId: item.id,
    displayCostNanoUsd: item.costNanoUsd,
  };
}

function countEvents(events: readonly InferenceEvent[], kind: InferenceEvent['kind']): number {
  return events.filter((event) => event.kind === kind).length;
}

/** The sources the fake search backend answers every query with, as a row stores them. */
async function fakeSources(): Promise<{ title: string; url: string }[]> {
  const answer = await createFakeSearchProvider().search(
    { query: 'any' },
    { signal: new AbortController().signal }
  );
  return answer.results.map(({ title, url }) => ({ title, url }));
}

/** One mock search step's answer: the echo of the prompt naming the first source's title. */
function mockSearchAnswer(firstTitle: string): string {
  return `${MOCK_ECHO_AFFIXES.prefix}${PROMPT}\n\nSource: ${firstTitle}${MOCK_ECHO_AFFIXES.suffix}`;
}

/** Two generations: the searching step and the answering step each report one. */
const SEARCH_TURN_MODEL_COST = providerUsdToBillableNanoUsd(
  MOCK_GENERATION_COST_USD + MOCK_GENERATION_COST_USD
);

/** Every usage row the run's settlement wrote. */
async function usageOf(runId: string): Promise<(typeof usageRecords.$inferSelect)[]> {
  return db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
}

/** What the run charged across every usage row. */
async function chargedOf(runId: string): Promise<bigint> {
  const usage = await usageOf(runId);
  return usage.reduce((total, row) => total + row.costNanoUsd, 0n);
}

/**
 * The tree a mock search turn that reasons streams: its thoughts and the searches
 * it ran (with those it refused counted) inside the reasoning, then the answer.
 */
async function expectedSearchTree(ran: number, refused: number): Promise<Segment[]> {
  const sources = await fakeSources();
  const firstTitle = sources[0]?.title;
  if (firstTitle === undefined) throw new Error('expected the fake backend to answer');
  return [
    {
      kind: 'reasoning',
      children: [
        { kind: 'text', text: MOCK_REASONING_TEXT },
        {
          kind: 'webSearch',
          row: {
            v: 1,
            searches: Array.from(
              { length: ran },
              (_unused, index): WebSearchEntry => ({
                query: `mock web search ${String(index + 1)}`,
                status: 'done',
                sources,
              })
            ),
            notRun: { limit: refused, invalidQuery: 0 },
          },
        },
      ],
    },
    { kind: 'text', text: mockSearchAnswer(firstTitle) },
  ];
}

/** Model cost, the searches that ran, and storage of the prompt and the stored text. */
async function expectedSearchCharge(payer: Payer, ran: number): Promise<bigint> {
  const persisted = await persistedAnswer(payer);
  return (
    SEARCH_TURN_MODEL_COST +
    toolCallChargeNanoUsd('webSearch', ran) +
    charStorageNanoUsd(PROMPT.length + persisted.text.length)
  );
}

/** What the answer's usage row charged beyond its model cost and the searches that ran. */
async function storageFeeOf(runId: string, ran: number): Promise<bigint> {
  const [usage] = await usageOf(runId);
  if (usage === undefined) throw new Error('expected a usage row for the answer');
  return usage.costNanoUsd - SEARCH_TURN_MODEL_COST - toolCallChargeNanoUsd('webSearch', ran);
}

describe('a searching turn pinned at Low, end to end', () => {
  const rung = 'low' satisfies ResolvedReasoningEffort;
  const cap = toolCallCapFor(rung);
  // Two more searches than the rung allows, so the cap has calls to refuse.
  const asked = cap + 2;
  let payer: Payer;
  let turn: ExecutedTurn;

  beforeAll(async () => {
    const model = await seedSearchModel();
    payer = await seedPayer(AMPLE_NANO_USD);
    const body = await sendSearchTurn(payer, model, rung, {
      'x-mock-web-search-count': String(asked),
    });
    turn = await executeInRoom(body, payer);
  }, 60_000);

  it('succeeds', () => {
    expect(turn.outcome).toEqual({ outcome: 'succeeded' });
  });

  it('declares the pinned rung loop on the searching answer', () => {
    expect(searchingAnswer(turn.definition).maxSteps).toBe(toolLoopStepsFor(cap));
  });

  it('holds exactly the loop formula at the rung cap and the declared ceiling', async () => {
    const answer = searchingAnswer(turn.definition);
    const expected = await rungHold(turn.definition, answer, rung, declaredCeiling(answer));
    expect(turn.holdNanoUsd).toBe(expected.total);
  });

  it('runs no more searches than the rung cap allows', () => {
    expect(countEvents(turn.events, 'tool-result')).toBe(cap);
  });

  it('refuses every search past the cap without running it', () => {
    const refused = turn.events.filter(
      (event) => event.kind === 'tool-error' && event.reason === 'limit'
    );
    expect(refused).toHaveLength(asked - cap);
  });

  it('writes one usage row, for the answer', async () => {
    const persisted = await persistedAnswer(payer);
    const usage = await usageOf(turn.runId);
    expect(usage.map((row) => row.contentItemId)).toEqual([persisted.contentItemId]);
  });

  it('charges the answer its model cost plus its searches plus storage', async () => {
    const [usage] = await usageOf(turn.runId);
    expect(usage?.costNanoUsd).toBe(await expectedSearchCharge(payer, cap));
  });

  it('counts the stored search-row text in the storage fee', async () => {
    const storedChars = serializeSegments(await expectedSearchTree(cap, asked - cap)).length;
    expect(await storageFeeOf(turn.runId, cap)).toBe(
      charStorageNanoUsd(PROMPT.length + storedChars)
    );
  });

  it('nets every ledger transaction of the charge to zero', async () => {
    const usage = await usageOf(turn.runId);
    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(
        inArray(
          ledgerEntries.usageRecordId,
          usage.map((row) => row.id)
        )
      );
    const net = new Map<string, bigint>();
    for (const leg of legs) {
      net.set(leg.transactionId, (net.get(leg.transactionId) ?? 0n) + leg.amountNanoUsd);
    }
    expect(legs.length).toBeGreaterThan(0);
    expect([...net.values()]).toEqual(Array.from({ length: net.size }, () => 0n));
  });

  it('displays a message cost that includes the searches', async () => {
    const persisted = await persistedAnswer(payer);
    expect(persisted.displayCostNanoUsd).toBe(await expectedSearchCharge(payer, cap));
  });

  it('persists text that parses to the nested tree the mock produced', async () => {
    const persisted = await persistedAnswer(payer);
    expect(parseAssistantMessage(persisted.text)).toEqual(
      await expectedSearchTree(cap, asked - cap)
    );
  });

  it('charges no more than it held', async () => {
    expect(await chargedOf(turn.runId)).toBeLessThanOrEqual(turn.holdNanoUsd);
  });
});

describe('a pinned Low turn that searches fewer times than its cap, end to end', () => {
  const rung = 'low' satisfies ResolvedReasoningEffort;
  // Under the rung's cap, so what ran and what the loop allows differ.
  const asked = 2;
  let payer: Payer;
  let turn: ExecutedTurn;

  beforeAll(async () => {
    const model = await seedSearchModel();
    payer = await seedPayer(AMPLE_NANO_USD);
    const body = await sendSearchTurn(payer, model, rung, {
      'x-mock-web-search-count': String(asked),
    });
    turn = await executeInRoom(body, payer);
  }, 60_000);

  it('runs every search it asked for, fewer than the cap', () => {
    expect(countEvents(turn.events, 'tool-result')).toBe(asked);
    expect(asked).toBeLessThan(toolCallCapFor(rung));
  });

  it('charges the answer for the searches that ran, not for the cap', async () => {
    const [usage] = await usageOf(turn.runId);
    expect(usage?.costNanoUsd).toBe(await expectedSearchCharge(payer, asked));
  });

  it('counts the stored search-row text in the storage fee', async () => {
    const storedChars = serializeSegments(await expectedSearchTree(asked, 0)).length;
    expect(await storageFeeOf(turn.runId, asked)).toBe(
      charStorageNanoUsd(PROMPT.length + storedChars)
    );
  });

  it('displays a message cost that includes only the searches that ran', async () => {
    const persisted = await persistedAnswer(payer);
    expect(persisted.displayCostNanoUsd).toBe(await expectedSearchCharge(payer, asked));
  });
});

describe('an Auto searching turn whose classifier decides Low, end to end', () => {
  const decided = 'low' satisfies ResolvedReasoningEffort;
  // More searches than the dearest rung allows, so the decided rung's cap is what binds.
  const asked = toolCallCapFor('max') + 2;
  let payer: Payer;
  let turn: ExecutedTurn;

  beforeAll(async () => {
    const model = await seedSearchModel();
    payer = await seedPayer(TIGHT_NANO_USD);
    const body = await sendSearchTurn(payer, model, 'auto', {
      'x-mock-web-search-count': String(asked),
      'x-mock-classifier-effort': decided,
    });
    turn = await executeInRoom(body, payer);
  }, 60_000);

  function availableRungs(): readonly (readonly [ResolvedReasoningEffort, number])[] {
    const ceilings = searchingAnswer(turn.definition).rungCeilings ?? {};
    return ResolvedReasoningEffort.options.flatMap(
      (rung): (readonly [ResolvedReasoningEffort, number])[] => {
        const ceiling = ceilings[rung];
        return ceiling === undefined ? [] : [[rung, ceiling]];
      }
    );
  }

  function decidedCeiling(): number {
    const ceiling = searchingAnswer(turn.definition).rungCeilings?.[decided];
    if (ceiling === undefined) throw new Error('expected the decided rung to be available');
    return ceiling;
  }

  /** The answer's call at the gateway: the run's one request that is not the classifier's. */
  function answerRequest(): InferenceRequest {
    const answer = turn.requests.find(
      (request) =>
        !request.inputs.some(
          (part) =>
            part.modality === 'text' && part.text.startsWith(CLASSIFIER_SYSTEM_PROMPT_MARKER)
        )
    );
    if (answer === undefined) throw new Error('expected the answer to reach the gateway');
    return answer;
  }

  /** The classifier's own hold: one tool-free step, consumed, so nothing of it is stored. */
  async function classifierHold(): Promise<bigint> {
    const classifier = turn.definition.nodes.find((node) => node.id === CHAT_CLASSIFIER_NODE_ID);
    if (classifier?.type !== 'modelCall') throw new Error('expected a classifier call');
    const rates = await heldRates(classifier.model);
    return (
      BigInt(promptTokens(classifier)) * rates.inputPerToken +
      BigInt(declaredCeiling(classifier)) * rates.outputPerToken
    );
  }

  it('succeeds', () => {
    expect(turn.outcome).toEqual({ outcome: 'succeeded' });
  });

  it('holds, beyond the classifier call, at least the hold of every available rung', async () => {
    const answer = searchingAnswer(turn.definition);
    const answerShare = turn.holdNanoUsd - (await classifierHold());
    const rungs = availableRungs();
    expect(rungs.length).toBeGreaterThan(1);
    for (const [rung, ceiling] of rungs) {
      const held = await rungHold(turn.definition, answer, rung, ceiling);
      expect(answerShare, rung).toBeGreaterThanOrEqual(held.total);
    }
  });

  it('holds the dearest available rung plus the classifier call', async () => {
    const answer = searchingAnswer(turn.definition);
    let dearest = 0n;
    for (const [rung, ceiling] of availableRungs()) {
      const held = await rungHold(turn.definition, answer, rung, ceiling);
      if (held.total > dearest) dearest = held.total;
    }
    expect(turn.holdNanoUsd).toBe(dearest + (await classifierHold()));
  });

  it('gives the decided rung a ceiling of its own, apart from the declared one', () => {
    expect(decidedCeiling()).not.toBe(declaredCeiling(searchingAnswer(turn.definition)));
  });

  it('records the rung the classifier decided on the answer', async () => {
    const usage = await usageOf(turn.runId);
    const completions = await db
      .select()
      .from(llmCompletions)
      .where(
        inArray(
          llmCompletions.usageRecordId,
          usage.map((row) => row.id)
        )
      );
    expect(completions.map((row) => row.reasoningEffort).filter(Boolean)).toEqual([decided]);
  });

  it('runs the answer at the decided rung ceiling', () => {
    expect(answerRequest().parameters['maxOutputTokens']).toBe(decidedCeiling());
  });

  it('runs no more searches than the decided rung cap allows', () => {
    expect(countEvents(turn.events, 'tool-result')).toBe(toolCallCapFor(decided));
  });

  it('charges no more than it held', async () => {
    expect(await chargedOf(turn.runId)).toBeLessThanOrEqual(turn.holdNanoUsd);
  });
});
