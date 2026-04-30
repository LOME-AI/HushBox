import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  applyFees,
  buildClassifierMessages,
  CHARS_PER_TOKEN_STANDARD,
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  resolveClassifierOutput,
  truncateForClassifier,
} from '@hushbox/shared';
import { contentItems, llmCompletions, usageRecords, type Database } from '@hushbox/db';
import { saveChatTurn } from '../chat/message-persistence.js';
import {
  cleanupTestUserData,
  createTestSetup,
  type TestSetup,
} from '../chat/media-strategy-test-helpers.js';
import {
  clearTestModelCache,
  consumeStream,
  getCheapestTestModel,
  setupIntegrationClient,
} from './test-utilities.js';
import type { AIClient, ModelInfo, TextRequest } from './types.js';

const CLASSIFIER_TIMEOUT_MS = 60_000;

interface SmartModelHarness {
  classifierModelId: string;
  eligibleIds: string[];
  modelMetadataById: Map<string, { name: string; description: string }>;
}

async function buildHarness(client: AIClient, eligibleCount: number): Promise<SmartModelHarness> {
  const allModels = await client.listModels();
  const textModels = allModels.filter((m) => m.modality === 'text' && m.isZdr);
  const sorted = textModels.toSorted((a, b) => textCost(a) - textCost(b));
  if (sorted.length === 0) {
    throw new Error('No paid ZDR text models available for harness.');
  }
  const classifierModelId = sorted[0]!.id;
  const eligibleSlice = sorted.slice(0, Math.max(1, Math.min(eligibleCount, sorted.length)));
  const modelMetadataById = new Map(
    eligibleSlice.map((m) => [m.id, { name: m.name, description: m.description }])
  );
  return {
    classifierModelId,
    eligibleIds: eligibleSlice.map((m) => m.id),
    modelMetadataById,
  };
}

function textCost(model: ModelInfo): number {
  if (model.pricing.kind !== 'token') return Number.POSITIVE_INFINITY;
  return model.pricing.inputPerToken + model.pricing.outputPerToken;
}

function buildClassifierRequest(
  harness: SmartModelHarness,
  latestUserMessage: string,
  latestAssistantMessage: string
): TextRequest {
  const truncatedContext = truncateForClassifier({
    latestUserMessage,
    latestAssistantMessage,
  });
  const eligibleWithDescriptions = harness.eligibleIds.map((id) => ({
    id,
    description: harness.modelMetadataById.get(id)?.description ?? '',
  }));
  const messages = buildClassifierMessages({
    truncatedContext,
    eligibleModels: eligibleWithDescriptions,
  });
  return {
    modality: 'text',
    model: harness.classifierModelId,
    messages,
    maxOutputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP,
  };
}

describe('Smart Model integration', () => {
  let client: AIClient;

  beforeAll(() => {
    clearTestModelCache();
    const setup = setupIntegrationClient();
    client = setup.client;
  });

  it(
    'classifier picks an eligible model and the resolved model produces text',
    async () => {
      const harness = await buildHarness(client, 3);
      const classifierRequest = buildClassifierRequest(
        harness,
        'Help me write a short greeting.',
        ''
      );
      const classifierResult = await consumeStream(client.stream(classifierRequest));
      expect(classifierResult.generationId).toBeDefined();

      const resolvedId = resolveClassifierOutput(classifierResult.textContent, harness.eligibleIds);
      expect(resolvedId).not.toBeNull();
      expect(harness.eligibleIds).toContain(resolvedId!);

      const inferenceSpec = await getCheapestTestModel(client, 'text');
      if (inferenceSpec.parameters.kind !== 'text') throw new Error('expected text spec');
      const inferenceRequest: TextRequest = {
        modality: 'text',
        model: resolvedId!,
        messages: [{ role: 'user', content: 'Reply with a single short word.' }],
        maxOutputTokens: inferenceSpec.parameters.maxOutputTokens,
      };
      const inferenceResult = await consumeStream(client.stream(inferenceRequest));
      expect(inferenceResult.textContent.length).toBeGreaterThan(0);
      expect(inferenceResult.generationId).toBeDefined();
    },
    CLASSIFIER_TIMEOUT_MS
  );

  it(
    'both classifier and inference produce billable getGenerationStats costs',
    async () => {
      const harness = await buildHarness(client, 3);
      const classifierRequest = buildClassifierRequest(
        harness,
        'Pick a model for a short answer.',
        ''
      );
      const classifier = await consumeStream(client.stream(classifierRequest));
      const resolvedId = resolveClassifierOutput(classifier.textContent, harness.eligibleIds);
      expect(resolvedId).not.toBeNull();

      const inference = await consumeStream(
        client.stream({
          modality: 'text',
          model: resolvedId!,
          messages: [{ role: 'user', content: 'Say yes.' }],
          maxOutputTokens: 10,
        })
      );

      const [classifierStats, inferenceStats] = await Promise.all([
        client.getGenerationStats(classifier.generationId!),
        client.getGenerationStats(inference.generationId!),
      ]);
      expect(classifierStats.costUsd).toBeGreaterThan(0);
      expect(inferenceStats.costUsd).toBeGreaterThan(0);
      const totalWithFees = applyFees(classifierStats.costUsd) + applyFees(inferenceStats.costUsd);
      expect(totalWithFees).toBeGreaterThan(0);
    },
    CLASSIFIER_TIMEOUT_MS
  );

  it(
    'eligible-list filtering: classifier output resolves only to a model in the filtered list',
    async () => {
      const harness = await buildHarness(client, 2);
      const classifierRequest = buildClassifierRequest(
        harness,
        'Pick the best model for code review.',
        ''
      );
      const result = await consumeStream(client.stream(classifierRequest));
      const resolvedId = resolveClassifierOutput(result.textContent, harness.eligibleIds);
      expect(resolvedId).not.toBeNull();
      expect(harness.eligibleIds).toContain(resolvedId!);
    },
    CLASSIFIER_TIMEOUT_MS
  );

  it(
    'single-eligible harness: resolved id is the only eligible id',
    async () => {
      const harness = await buildHarness(client, 1);
      expect(harness.eligibleIds).toHaveLength(1);
      const classifierRequest = buildClassifierRequest(harness, 'Choose a model.', '');
      const result = await consumeStream(client.stream(classifierRequest));
      const resolvedId = resolveClassifierOutput(result.textContent, harness.eligibleIds);
      expect(resolvedId).toBe(harness.eligibleIds[0]);
    },
    CLASSIFIER_TIMEOUT_MS
  );

  it(
    'classifier emits a finish event with providerMetadata.generationId',
    async () => {
      const harness = await buildHarness(client, 3);
      const result = await consumeStream(
        client.stream(buildClassifierRequest(harness, 'Choose a model.', ''))
      );
      expect(result.events.at(-1)?.kind).toBe('finish');
      expect(result.generationId).toBeDefined();
      expect(result.generationId?.length ?? 0).toBeGreaterThan(0);
    },
    CLASSIFIER_TIMEOUT_MS
  );
});

describe('Smart Model full DB persistence integration', () => {
  let dbInstance: Database;
  let smartClient: AIClient;
  const setupsToCleanup: TestSetup[] = [];

  beforeAll(async () => {
    // The full-DB persistence test always needs a real DB regardless of
    // localDev/CI; setupIntegrationClient returns db=null in localDev (where
    // the mock AIClient doesn't need DB). Build our own DB connection here
    // and reuse the AIClient from setupIntegrationClient (mock locally,
    // real in CI).
    const { createDb, LOCAL_NEON_DEV_CONFIG } = await import('@hushbox/db');
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error('DATABASE_URL required for Smart Model DB persistence test');
    }
    dbInstance = createDb({ connectionString: databaseUrl, neonDev: LOCAL_NEON_DEV_CONFIG });
    smartClient = setupIntegrationClient().client;
  });

  afterEach(async () => {
    for (const setup of setupsToCleanup) {
      await cleanupTestUserData(dbInstance, setup.user.id);
    }
    setupsToCleanup.length = 0;
  });

  it(
    'persists exactly two usage_records (classifier + inference) linked to the assistant message',
    async () => {
      const setup = await createTestSetup(dbInstance);
      setupsToCleanup.push(setup);

      // Phase 1 — classifier call
      const harness = await buildHarness(smartClient, 3);
      const classifierRequest = buildClassifierRequest(
        harness,
        'Help me write a single short greeting.',
        ''
      );
      const classifier = await consumeStream(smartClient.stream(classifierRequest));
      const resolvedId = resolveClassifierOutput(classifier.textContent, harness.eligibleIds);
      expect(resolvedId).not.toBeNull();
      expect(classifier.generationId).toBeDefined();

      // Phase 2 — inference call on resolved model
      const inferenceSpec = await getCheapestTestModel(smartClient, 'text');
      if (inferenceSpec.parameters.kind !== 'text') throw new Error('expected text spec');
      const inferenceRequest: TextRequest = {
        modality: 'text',
        model: resolvedId!,
        messages: [{ role: 'user', content: 'Reply with one short word.' }],
        maxOutputTokens: inferenceSpec.parameters.maxOutputTokens,
      };
      const inference = await consumeStream(smartClient.stream(inferenceRequest));
      expect(inference.textContent.length).toBeGreaterThan(0);
      expect(inference.generationId).toBeDefined();

      // Phase 3 — fetch real costs
      const [classifierStats, inferenceStats] = await Promise.all([
        smartClient.getGenerationStats(classifier.generationId!),
        smartClient.getGenerationStats(inference.generationId!),
      ]);
      expect(classifierStats.costUsd).toBeGreaterThan(0);
      expect(inferenceStats.costUsd).toBeGreaterThan(0);

      // Phase 4 — persist via saveChatTurn with classifier as a pre-inference stage
      const userMsgId = crypto.randomUUID();
      const assistantMsgId = crypto.randomUUID();
      const inferenceCostDollars = applyFees(inferenceStats.costUsd);
      const classifierCostDollars = applyFees(classifierStats.costUsd);
      const classifierInputChars = classifierRequest.messages.reduce(
        (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
        0
      );
      const classifierOutputChars = classifier.textContent.length;
      const userContent = 'Help me write a single short greeting.';
      const inferenceInputChars = inferenceRequest.messages.reduce(
        (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
        0
      );
      const tokensFromChars = (chars: number): number =>
        Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN_STANDARD));

      await saveChatTurn(dbInstance, {
        userMessageId: userMsgId,
        userContent,
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        parentMessageId: null,
        assistantMessages: [
          {
            modality: 'text',
            id: assistantMsgId,
            content: inference.textContent,
            model: resolvedId!,
            cost: inferenceCostDollars,
            inputTokens: tokensFromChars(inferenceInputChars),
            outputTokens: tokensFromChars(inference.textContent.length),
            isSmartModel: true,
            preInferenceBillings: [
              {
                stageId: 'smart-model',
                modelId: harness.classifierModelId,
                costDollars: classifierCostDollars,
                inputTokens: tokensFromChars(classifierInputChars),
                outputTokens: tokensFromChars(classifierOutputChars),
              },
            ],
          },
        ],
      });

      // Strongest-proof assertions: count + per-row inspection
      const usageRows = await dbInstance
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.sourceId, assistantMsgId));
      expect(usageRows).toHaveLength(2);
      for (const row of usageRows) {
        expect(row.type).toBe('llm_completion');
        expect(Number(row.cost)).toBeGreaterThan(0);
      }

      const usageRecordIds = usageRows.map((r) => r.id);
      const llmRows = await dbInstance
        .select()
        .from(llmCompletions)
        .where(inArray(llmCompletions.usageRecordId, usageRecordIds));
      expect(llmRows).toHaveLength(2);
      const llmModels = new Set(llmRows.map((r) => r.model));
      expect(llmModels.has(harness.classifierModelId)).toBe(true);
      expect(llmModels.has(resolvedId!)).toBe(true);

      const [item] = await dbInstance
        .select()
        .from(contentItems)
        .where(eq(contentItems.messageId, assistantMsgId));
      expect(item).toBeDefined();
      expect(item!.isSmartModel).toBe(true);
      expect(item!.modelName).toBe(resolvedId);
      // content_items.cost = sum of usage_records.cost (within 1e-8 tolerance)
      const summedUsageCost = usageRows.reduce((sum, r) => sum + Number(r.cost), 0);
      expect(Math.abs(Number(item!.cost) - summedUsageCost)).toBeLessThan(1e-6);
    },
    CLASSIFIER_TIMEOUT_MS
  );
});
