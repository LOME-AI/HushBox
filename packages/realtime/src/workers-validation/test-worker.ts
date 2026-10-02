import { createConversationRoomClass } from '../conversation-room.js';
import { createJobDispatcherClass } from '../job-dispatcher.js';
import type {
  FlowExecutor,
  FlowRunOutcome,
  FlowStopReason,
  FlowStreamEvent,
} from '@hushbox/shared';
import type { HeldStreamStartRequest, RoomBindings } from '../conversation-room.js';
import type { JobPassResult } from '../job-dispatcher-core.js';

/**
 * Thin-shell test DO (the arch pattern: a DO class contains only platform
 * glue). All room behavior lives in the plain core the node project covers;
 * this binding exists solely to prove the shell's platform glue — upgrade,
 * hibernatable attachments, the deadline alarm, eviction — under workerd.
 *
 * The executor fake completes only when stopped or aborted, so the
 * deadline-alarm test can observe run control: alarm → abort('deadline-hard')
 * → outcome 'stopped' → run-finished frame.
 */
const stopDrivenExecutor: FlowExecutor = {
  start(request: HeldStreamStartRequest) {
    let resolveDone!: (outcome: FlowRunOutcome) => void;
    const done = new Promise<FlowRunOutcome>((resolve) => {
      resolveDone = resolve;
    });
    roomRunControl.emit = request.emit;
    // A held-stream run (dev/E2E) parks until the DO's release route resolves the
    // threaded barrier, then completes — proving the barrier end to end. Every
    // other run stays stop-driven so the deadline-alarm glue test is unchanged.
    // Standing in for the mock provider's stride: each release carries the run
    // one frame further and parks it again, so a shell test can drive a run that
    // parks more than once.
    const held = request.awaitStreamRelease;
    if (held !== undefined) {
      const parks = roomRunControl.parksPerRun;
      void (async () => {
        for (let park = 1; park <= parks; park += 1) {
          roomRunControl.parks += 1;
          await held();
          // The window between a release and the next park, which is where a
          // second release for the same run lands. Nothing stalls unless a test
          // asked for it, so every other case runs at full speed.
          const stall = resumeStall;
          if (stall !== null) {
            resumeStall = null;
            roomRunControl.stalled = true;
            await stall;
            roomRunControl.stalled = false;
          }
          roomRunControl.advanced += 1;
        }
        resolveDone({ outcome: 'succeeded' });
      })();
    }
    return {
      runKey: request.runKey,
      done,
      admitted: Promise.resolve({ admitted: true }),
      stop(reason: FlowStopReason): void {
        resolveDone(reason === 'deadline' ? { outcome: 'stopped' } : { outcome: 'succeeded' });
      },
      abort(): void {
        resolveDone({ outcome: 'stopped' });
      },
    };
  },
};

/**
 * Hands the live run's stream emitter to the shell tests. Driving a socket
 * through the DO accept path INTO a run that is producing frames is the one
 * path the platform glue cannot be proven without, and the emitter is the only
 * way to produce those frames from outside the executor.
 */
export const roomRunControl = {
  emit: null as ((event: FlowStreamEvent) => void) | null,
  /** How many times a held run parks at the release barrier before it completes. */
  parksPerRun: 1,
  /** Parks the held run has entered, counted as it reaches each one. */
  parks: 0,
  /** Releases the held run has resumed from — the work one release let through. */
  advanced: 0,
  /** True while the run sits in the post-release window, before its next park. */
  stalled: false,
  /**
   * Holds the run in that window once, so a test can land a second release for
   * the same run while the first one is still waiting to be answered.
   */
  stallNextResume(): void {
    resumeStall = new Promise<void>((resolve) => {
      freeResumeStall = resolve;
    });
  },
  /** Lets a stalled run carry on to its next park. */
  freeStall(): void {
    freeResumeStall?.();
    resumeStall = null;
    freeResumeStall = null;
  },
};

let resumeStall: Promise<void> | null = null;
let freeResumeStall: (() => void) | null = null;

let runCounter = 0;

/** The one answer id every validation run's binding mints. */
export const WORKERS_VALIDATION_ANSWER_ID = 'workers-validation-answer';

const dropTelemetryEvent = (): void => {
  // The validation room drops telemetry: these tests assert platform glue,
  // not observability.
};

/**
 * Records the metric-bearing room telemetry so the shell tests can prove the
 * DO fires `upgradeRejected` at its upgrade-failure branch (the metric
 * emission itself is a plain-module binding covered under the node project).
 */
export const roomTelemetryControl = {
  upgradeRejected: [] as { conversationId: string }[],
};

let heldTrack: Promise<void> | null = null;
let releaseHeldTrack: (() => void) | null = null;

/**
 * Scripts the active-room tracker so the shell tests can drive the one
 * upgrade step that is allowed to fail: a rejected track must leave nothing
 * accepted.
 *
 * `hold` additionally parks every upgrade inside connection setup, which is
 * the only await the shell offers between an upgrade's arrival and its
 * acceptance. Holding a whole burst there and releasing it at once is how a
 * shell test drives simultaneous upgrades against a roster none of them has
 * been added to yet; `parked` counts the upgrades currently waiting, so a test
 * can release exactly when its burst is fully in flight.
 */
export const roomTrackerControl = {
  failNextTrack: false,
  parked: 0,
  hold(): void {
    heldTrack = new Promise<void>((resolve) => {
      releaseHeldTrack = resolve;
    });
  },
  release(): void {
    releaseHeldTrack?.();
    heldTrack = null;
    releaseHeldTrack = null;
    roomTrackerControl.parked = 0;
  },
};

let heldVerification: Promise<void> | null = null;
let releaseHeldVerification: (() => void) | null = null;

/**
 * Parks the next membership verification, and with it the room's delivery
 * chain. Holding a frame queued while a socket completes its upgrade is the
 * only way a shell test can reach the window the connection-setup declaration
 * exists for; nothing else in the shell can suspend a delivery.
 */
export const roomVerifierControl = {
  holdNext(): void {
    heldVerification = new Promise<void>((resolve) => {
      releaseHeldVerification = resolve;
    });
  },
  release(): void {
    releaseHeldVerification?.();
    heldVerification = null;
    releaseHeldVerification = null;
  },
};

const bindings: RoomBindings = {
  executor: stopDrivenExecutor,
  verifier: {
    verify: async (): Promise<'member'> => {
      const held = heldVerification;
      heldVerification = null;
      if (held !== null) await held;
      return 'member';
    },
  },
  // Wired live so the shell tests exercise the broadcast-time session check
  // against real hibernated attachments: a socket the room cannot session-check
  // is cut by the core, never by this binding.
  sessionVerifier: { verify: () => Promise.resolve('live' as const) },
  telemetry: {
    runStarted: dropTelemetryEvent,
    runFinished: dropTelemetryEvent,
    runRejected: dropTelemetryEvent,
    deadlineFired: dropTelemetryEvent,
    principalEvicted: dropTelemetryEvent,
    deliveryPaused: dropTelemetryEvent,
    deliveryFailed: dropTelemetryEvent,
    deliveryResumed: dropTelemetryEvent,
    clientMessageRejected: dropTelemetryEvent,
    upgradeRejected: (fields) => {
      roomTelemetryControl.upgradeRejected.push(fields);
    },
    billableGeneration: dropTelemetryEvent,
  },
  // Fresh executor claim so the shell tests exercise the run-start → alarm →
  // run-finished platform glue; the real referee lives in the workflows engine.
  claimRun: () =>
    Promise.resolve({
      outcome: 'executor',
      fence: {
        id: 'workers-validation-fence',
        executorId: 'workers-validation-executor',
        claims: 1,
      },
    }),
  bindHooks: () => ({
    admission: () => Promise.resolve({ admitted: true, holdRef: 'workers-validation-hold' }),
    settlement: () => Promise.resolve(),
    assistantMessageIds: [WORKERS_VALIDATION_ANSWER_ID],
  }),
  maxStreamBytes: 1_000_000,
  maxRunBytes: 8_000_000,
  now: () => Date.now(),
  newRunId: () => {
    runCounter += 1;
    return `run-${String(runCounter)}`;
  },
  // Money/lease duties are no-ops here: the shell tests assert platform glue;
  // the real capabilities are injected by the apps/api room bindings.
  releaseHold: () => Promise.resolve(),
  heartbeat: () => Promise.resolve('alive' as const),
  failRun: () => Promise.resolve(),
  userRooms: {
    track: (): Promise<void> => {
      if (roomTrackerControl.failNextTrack) {
        roomTrackerControl.failNextTrack = false;
        return Promise.reject(new Error('scripted track failure'));
      }
      const held = heldTrack;
      if (held === null) return Promise.resolve();
      roomTrackerControl.parked += 1;
      return held;
    },
    untrack: (): Promise<void> => Promise.resolve(),
  },
};

export const TestConversationRoom = createConversationRoomClass(() => bindings);
export type TestConversationRoom = InstanceType<typeof TestConversationRoom>;

/**
 * Scripts the dispatcher's fake pass executor. The workers project runs in
 * the same isolate as this worker, so tests mutate this module state
 * directly; the dispatcher shell tests assert platform glue only (arm-first
 * through a real alarm, wake over fetch) — pass behavior lives in the
 * node-covered cores.
 */
export const jobDispatcherControl = {
  passes: [] as string[],
  results: [] as JobPassResult[],
  failNextPass: false,
};

export const TestJobDispatcher = createJobDispatcherClass(() => ({
  executor: {
    runPass: (shard: string): Promise<JobPassResult> => {
      jobDispatcherControl.passes.push(shard);
      if (jobDispatcherControl.failNextPass) {
        jobDispatcherControl.failNextPass = false;
        return Promise.reject(new Error('scripted pass failure'));
      }
      const next = jobDispatcherControl.results.shift();
      return Promise.resolve(next ?? { kind: 'idle' });
    },
  },
  telemetry: { passFailed: dropTelemetryEvent },
  now: () => Date.now(),
}));
export type TestJobDispatcher = InstanceType<typeof TestJobDispatcher>;

/**
 * The workerd validation project's entry module: `vitest.workers.config.ts`
 * names this file as miniflare's `main` and the runtime reads its default
 * export, so no module imports it.
 * @toolContract
 */
export default {
  fetch(): Response {
    return new Response('realtime workers-validation test worker');
  },
};
