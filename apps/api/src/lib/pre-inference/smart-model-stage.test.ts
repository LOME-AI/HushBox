import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODE_CLASSIFIER_FAILED } from '@hushbox/shared';

import { createMockAIClient } from '../../services/ai/mock.js';
import type { SSEEventWriter } from '../stream-handler.js';

import { createSmartModelStage } from './smart-model-stage.js';

function createRecordingWriter(): SSEEventWriter & {
  events: { method: string; payload: unknown }[];
} {
  const events: { method: string; payload: unknown }[] = [];
  const record =
    (method: string) =>
    (payload: unknown): Promise<void> => {
      events.push({ method, payload });
      return Promise.resolve();
    };
  return {
    events,
    writeStart: record('writeStart') as SSEEventWriter['writeStart'],
    writeToken: record('writeToken') as SSEEventWriter['writeToken'],
    writeModelToken: record('writeModelToken') as SSEEventWriter['writeModelToken'],
    writeError: record('writeError') as SSEEventWriter['writeError'],
    writeModelDone: record('writeModelDone') as SSEEventWriter['writeModelDone'],
    writeModelError: record('writeModelError') as SSEEventWriter['writeModelError'],
    writeDone: record('writeDone') as SSEEventWriter['writeDone'],
    writeStageStart: record('writeStageStart') as SSEEventWriter['writeStageStart'],
    writeStageDone: record('writeStageDone') as SSEEventWriter['writeStageDone'],
    writeStageError: record('writeStageError') as SSEEventWriter['writeStageError'],
    isConnected: () => true,
  };
}

const ELIGIBLE: readonly string[] = [
  'anthropic/claude-opus-4.6',
  'anthropic/claude-sonnet-4.6',
  'cheap/c',
];

const METADATA = new Map([
  ['anthropic/claude-opus-4.6', { name: 'Claude Opus 4.6', description: 'Most capable.' }],
  ['anthropic/claude-sonnet-4.6', { name: 'Claude Sonnet 4.6', description: 'Balanced.' }],
  ['cheap/c', { name: 'Cheap C', description: 'Cheapest.' }],
]);

function makeStage(overrides: Partial<Parameters<typeof createSmartModelStage>[0]> = {}) {
  return createSmartModelStage({
    classifierModelId: 'cheap/c',
    eligibleInferenceIds: ELIGIBLE,
    classifierWorstCaseCents: 12,
    modelMetadataById: METADATA,
    conversationContext: { latestUserMessage: 'help me with python', latestAssistantMessage: '' },
    ...overrides,
  });
}

describe('SmartModelStage', () => {
  it('reports the correct stage id', () => {
    expect(makeStage().id).toBe('smart-model');
  });

  it('reports the configured classifier worst-case cents from reserveCents', () => {
    expect(makeStage({ classifierWorstCaseCents: 42 }).reserveCents()).toBe(42);
  });

  it('emits stage:start, runs the classifier, and emits stage:done with the resolved model', async () => {
    const aiClient = createMockAIClient();
    aiClient.setClassifierResolution('anthropic/claude-opus-4.6');
    const writer = createRecordingWriter();
    const stage = makeStage();

    const outcome = await stage.run({
      aiClient,
      writer,
      assistantMessageId: 'asst-smart',
      upstream: {},
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.transformation).toEqual({ resolvedModelId: 'anthropic/claude-opus-4.6' });
    expect(outcome.billing).toMatchObject({
      stageId: 'smart-model',
      modelId: 'cheap/c',
    });
    expect(outcome.billing?.generationId).toBeTruthy();

    const startEvent = writer.events.find((e) => e.method === 'writeStageStart');
    expect(startEvent?.payload).toMatchObject({
      stageId: 'smart-model',
      assistantMessageId: 'asst-smart',
    });

    const doneEvent = writer.events.find((e) => e.method === 'writeStageDone');
    expect(doneEvent?.payload).toMatchObject({
      assistantMessageId: 'asst-smart',
      payload: {
        stageId: 'smart-model',
        resolvedModelId: 'anthropic/claude-opus-4.6',
        resolvedModelName: 'Claude Opus 4.6',
      },
    });
  });

  it('passes a TextRequest to aiClient.stream with the classifier model and capped output tokens', async () => {
    const aiClient = createMockAIClient();
    aiClient.setClassifierResolution('cheap/c');
    const streamSpy = vi.spyOn(aiClient, 'stream');
    const writer = createRecordingWriter();

    await makeStage().run({
      aiClient,
      writer,
      assistantMessageId: 'asst-1',
      upstream: {},
    });

    expect(streamSpy).toHaveBeenCalledTimes(1);
    const request = streamSpy.mock.calls[0]?.[0];
    expect(request?.modality).toBe('text');
    if (request?.modality !== 'text') return;
    expect(request.model).toBe('cheap/c');
    expect(request.maxOutputTokens).toBeGreaterThan(0);
    expect(request.messages.find((m) => m.role === 'system')?.content).toContain(
      '[HUSHBOX_CLASSIFIER]'
    );
  });

  it('returns CLASSIFIER_FAILED when the classifier call throws', async () => {
    const aiClient = createMockAIClient();
    aiClient.setClassifierFailure(new Error('upstream gone'));
    const writer = createRecordingWriter();

    const outcome = await makeStage().run({
      aiClient,
      writer,
      assistantMessageId: 'asst-1',
      upstream: {},
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorCode).toBe(ERROR_CODE_CLASSIFIER_FAILED);

    const errorEvent = writer.events.find((e) => e.method === 'writeStageError');
    expect(errorEvent?.payload).toMatchObject({
      stageId: 'smart-model',
      assistantMessageId: 'asst-1',
      errorCode: ERROR_CODE_CLASSIFIER_FAILED,
    });
    // No stage:done emitted on failure
    expect(writer.events.find((e) => e.method === 'writeStageDone')).toBeUndefined();
  });

  it('returns CLASSIFIER_FAILED when the classifier output cannot be resolved', async () => {
    const aiClient = createMockAIClient();
    aiClient.setClassifierResolution('totally-unrelated-id-not-in-eligible');
    const writer = createRecordingWriter();

    const outcome = await makeStage().run({
      aiClient,
      writer,
      assistantMessageId: 'asst-1',
      upstream: {},
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorCode).toBe(ERROR_CODE_CLASSIFIER_FAILED);
  });

  it('falls back to the model id when name metadata is missing', async () => {
    const aiClient = createMockAIClient();
    aiClient.setClassifierResolution('cheap/c');
    const writer = createRecordingWriter();

    const stage = makeStage({ modelMetadataById: new Map() });

    const outcome = await stage.run({
      aiClient,
      writer,
      assistantMessageId: 'asst-1',
      upstream: {},
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const doneEvent = writer.events.find((e) => e.method === 'writeStageDone');
    expect(doneEvent?.payload).toMatchObject({
      payload: { resolvedModelName: 'cheap/c' },
    });
  });
});
