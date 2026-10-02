import { describe, expect, it } from 'vitest';
import { nanoUSD } from '../affordability/money/nano-usd.ts';
import { senderPrincipalId } from '../principal-id.ts';
import { WorkflowDefinition } from './workflow.ts';
import type { FilePartMapper } from './inference.ts';
import type {
  AdmissionDecision,
  FlowAdmissionOutcome,
  FlowExecutor,
  FlowHoldIdentity,
  FlowRunOutcome,
  FlowStartRequest,
  FlowStreamEvent,
  MediaPersistPlan,
  PaidRunIdentity,
} from './flow-executor.ts';

const definition = WorkflowDefinition.parse({
  version: 1,
  deadlineClass: 'text',
  hooks: { admission: 'chatBalanceHold', settlement: 'saveChatTurn' },
  nodes: [
    {
      id: 'answer',
      version: 1,
      out: 'out',
      type: 'modelCall',
      model: 'openai/gpt-5',
      params: {},
      in: { node: 'input', port: 'out' },
    },
  ],
  edges: [],
});

/**
 * A minimal in-memory implementation proving the seam is implementable: the
 * DO in packages/realtime is parameterized over this interface and apps/api
 * binds it. Behavior here is fake; the contract is the test.
 */
function fakeExecutor(): FlowExecutor {
  return {
    start(request) {
      let cursor = 0;
      const streamId = 'stream-1';
      let resolveAdmitted: (outcome: FlowAdmissionOutcome) => void;
      const admitted = new Promise<FlowAdmissionOutcome>((resolve) => {
        resolveAdmitted = resolve;
      });
      const run = async (): Promise<FlowRunOutcome> => {
        const decision = await request.hooks.admission({
          definition: request.definition,
          estimate: nanoUSD(1000n),
        });
        if (!decision.admitted) {
          resolveAdmitted({ admitted: false, code: decision.code });
          return { outcome: 'failed', code: decision.code };
        }
        resolveAdmitted({
          admitted: true,
          ...(decision.hold === undefined ? {} : { hold: decision.hold }),
        });
        request.emit({
          streamId,
          cursor: cursor++,
          event: { kind: 'text-delta', index: 0, content: 'hi' },
        });
        await request.hooks.settlement({ runKey: request.runKey, outputs: {}, charges: [] });
        return { outcome: 'succeeded' };
      };
      return { runKey: request.runKey, done: run(), admitted, stop: () => {}, abort: () => {} };
    },
  };
}

describe('FlowExecutor contract', () => {
  it('the interface admits a fixture that emits cursored events and settles', async () => {
    const events: FlowStreamEvent[] = [];
    const settled: string[] = [];
    const executor = fakeExecutor();
    const handle = executor.start({
      definition,
      inputs: { prompt: { kind: 'text', text: 'hello' } },
      runKey: 'key-1',
      hooks: {
        admission: () => Promise.resolve({ admitted: true, holdRef: 'hold-1' }),
        settlement: (request) => {
          settled.push(request.runKey);
          return Promise.resolve();
        },
      },
      emit: (event) => events.push(event),
    });
    expect(handle.runKey).toBe('key-1');
    await expect(handle.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ streamId: 'stream-1', cursor: 0 });
    expect(settled).toEqual(['key-1']);
  });

  it('the interface admits a fixture that reports a refused admission through the typed code', async () => {
    const refusal: AdmissionDecision = { admitted: false, code: 'INSUFFICIENT_ADMISSION' };
    const executor = fakeExecutor();
    const handle = executor.start({
      definition,
      inputs: {},
      runKey: 'key-2',
      hooks: {
        admission: () => Promise.resolve(refusal),
        settlement: () => Promise.resolve(),
      },
      emit: () => {},
    });
    await expect(handle.done).resolves.toEqual({
      outcome: 'failed',
      code: 'INSUFFICIENT_ADMISSION',
    });
    await expect(handle.admitted).resolves.toEqual({
      admitted: false,
      code: 'INSUFFICIENT_ADMISSION',
    });
  });

  it('the interface carries a granted hold identity on the admitted promise', async () => {
    const hold: FlowHoldIdentity = { walletId: 'w1', holdId: 'run-1', scopeIds: ['s1'] };
    const executor = fakeExecutor();
    const handle = executor.start({
      definition,
      inputs: {},
      runKey: 'key-3',
      hooks: {
        admission: () => Promise.resolve({ admitted: true, holdRef: 'run-1', hold }),
        settlement: () => Promise.resolve(),
      },
      emit: () => {},
    });
    await expect(handle.admitted).resolves.toEqual({ admitted: true, hold });
    await expect(handle.done).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('expresses stop reasons and outcomes at the type level', () => {
    const outcomes: FlowRunOutcome[] = [
      { outcome: 'succeeded' },
      { outcome: 'stopped' },
      { outcome: 'failed', code: 'TIMEOUT' },
    ];
    expect(outcomes).toHaveLength(3);
  });
});

describe('PaidRunIdentity sender', () => {
  it('carries a link-guest sender beside the payer user id', () => {
    const identity: PaidRunIdentity = {
      mode: 'paid',
      payerUserId: 'owner-1',
      sender: { kind: 'linkGuest', linkId: 'l1' },
      conversationId: 'c1',
      walletId: 'w1',
      epochNumber: 2,
      userMessage: { id: 'um1', content: 'hi' },
    };
    expect(identity.sender).toEqual({ kind: 'linkGuest', linkId: 'l1' });
    expect(identity.payerUserId).toBe('owner-1');
  });

  it("holds the sender's principal id only through the principal, not beside it", () => {
    const identity: PaidRunIdentity = {
      mode: 'paid',
      payerUserId: 'owner-1',
      sender: { kind: 'linkGuest', linkId: 'l1' },
      conversationId: 'c1',
      walletId: 'w1',
      epochNumber: 2,
      userMessage: { id: 'um1', content: 'hi' },
    };
    expect(senderPrincipalId(identity.sender)).toBe('l1');
    expect(identity).not.toHaveProperty('senderId');
  });
});

describe('MediaPersistPlan', () => {
  it('carries the pre-minted persistence identity for one media generation', () => {
    const plan: MediaPersistPlan = {
      assistantMessageId: 'msg-1',
      contentItemId: 'ci-1',
      epochNumber: 3,
      wrappedContentKey: new Uint8Array(72),
    };
    expect(plan.contentItemId).toBe('ci-1');
  });

  it('accepts a per-node file-part mapper resolver on the flow start request', () => {
    const boundMapper: FilePartMapper = (part, index) => [
      { kind: 'media-start', index, modality: 'image', mimeType: part.mediaType },
      {
        kind: 'media-done',
        index,
        value: {
          ref: 'ci-1',
          mimeType: part.mediaType,
          modality: 'image',
          byteLength: part.data.byteLength,
          metadata: {},
        },
      },
    ];
    const mappers = new Map<string, FilePartMapper>([['answer', boundMapper]]);
    const mapFilePartFor: NonNullable<FlowStartRequest['mapFilePartFor']> = (nodeKey) =>
      mappers.get(nodeKey);
    expect(mapFilePartFor('other')).toBeUndefined();
    expect(mapFilePartFor('answer')).toBe(boundMapper);
  });
});
