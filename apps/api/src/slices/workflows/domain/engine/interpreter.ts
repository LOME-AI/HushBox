import { match } from 'ts-pattern';
import {
  DEADLINE_CLASS_MS,
  END_NODE_ID,
  ERROR_CODES,
  isTurnClassifierNode,
  mapWithConcurrency,
  VALUE_STORE_BYTE_BUDGET_BYTES,
  zodFor,
} from '@hushbox/shared';
import { domainWireCode } from '../../../../lib/errors/index.js';
import { FINGERPRINT_CODES } from '../../../../lib/telemetry/index.js';
import {
  FAN_OUT_ELEMENT_PORT_ID,
  LOOP_STATE_PORT_ID,
  WORKFLOW_INPUT_NODE_ID,
} from '../compile/conventions.js';
import { contentValueOf } from './channel-values.js';
import { circuitReadoutOf } from './hooks.js';
import { createValueStore } from './value-store.js';
import {
  AbsorbedSettlementRefusal,
  AllBranchesFailedError,
  InfrastructureUnavailableError,
  SettlementConflictError,
  absorbedLossEvent,
  costCircuitTripEvent,
  runFailureCode,
} from './failures.js';
import { collectCharge } from './run-charges.js';
import { ingestRun } from './run-plan.js';
import {
  FAILED_DEFECT,
  LEVEL_STREAM_CONCURRENCY,
  applyNodeFailure,
  clientContextFor,
  commitsModelReply,
  feedsInPortOrder,
  finalCostOf,
  levelInFlightWidth,
  openSpendLedger,
  isDownloadByteCapExceeded,
  isValueNode,
  readChannel,
  storeInChannel,
  virtualKey,
} from './run-steps.js';
import type {
  FlowAbortReason,
  FlowAdmissionOutcome,
  FlowExecutor,
  FlowRunHandle,
  FlowRunOutcome,
  FlowStartRequest,
  FlowStopReason,
  Node,
  NodeId,
  SchemaNameRegistry,
  SettlementCharge,
  WorkflowDefinition,
  ContentValue,
} from '@hushbox/shared';
import type { RunReservation } from '@hushbox/shared/affordability/price/reservation';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result } from '../../../../lib/result/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type {
  CompiledDefinition,
  CompiledNode,
  CompiledNodeInput,
} from '../compile/compile-definition.js';
import type { CompileContext, ValueNode } from '../compile/context.js';
import type {
  EngineClock,
  EngineExecutionRegistry,
  EngineRng,
  NodeRunContext,
  NodeRunError,
  NodeRunSuccess,
  RegisteredPredicate,
  SpendGate,
  SpendGateCause,
} from './execution-registry.js';
import type { RunFailure } from './failures.js';
import type { RunValueStore } from './value-store.js';
import type {
  CommitOutcome,
  ExecutedValue,
  LevelResolution,
  LoopGate,
  NodeStep,
  Produced,
  ProducedValue,
  Scope,
  ValueTarget,
} from './run-steps.js';

/**
 * The in-memory workflow interpreter: one continuous execution inside the
 * conversation DO, values passing through the byte-metered ValueStore,
 * nothing durable until the settlement hook commits. The engine owns run
 * sequencing — ingress validation, the server-computed estimate, admission,
 * the deadline, the `hold × K` cost circuit, and settlement ordering; no run
 * starts or settles except through the definition's declared policy hooks.
 *
 * One run per conversation is enforced upstream: the ConversationRoom DO
 * claims via RunControl and the idempotency-key row before `start()` — this
 * module runs exactly the one run it was handed.
 */

interface WorkflowExecutorDeps {
  /** Compile-time registries: node port declarations + named constraints. */
  readonly registries: Omit<CompileContext, 'workflowInputs'>;
  readonly execution: EngineExecutionRegistry;
  /**
   * Reserves the definition's declared ceiling (max width × iterations, each
   * tool-carrying node over every step of its loop), call by call. The admission
   * hook only ever receives this server-computed estimate's total — no path
   * accepts a caller-supplied one.
   */
  readonly estimateRun: (definition: WorkflowDefinition) => Result<RunReservation, DomainError>;
  readonly clock: EngineClock;
  readonly rng: EngineRng;
  readonly telemetry: Telemetry;
  readonly valueBudgetBytes?: number;
}

/** Single-use state and logic for one run. */
class RunExecution {
  private readonly store: RunValueStore;
  private readonly controller = new AbortController();
  private admittedResolve!: (outcome: FlowAdmissionOutcome) => void;
  readonly admitted: Promise<FlowAdmissionOutcome>;
  private readonly rootScope: Scope = { channels: new Map(), virtual: new Map() };
  private readonly inputChannels = new Map<string, unknown>();
  private readonly schemaRegistry: SchemaNameRegistry;
  /** Set by a clean ingest; walk and finalize run only after it. */
  private compiled!: CompiledDefinition;
  private childDriven: ReadonlySet<string> = new Set();
  private skipped = new Set<string>();
  /** Topological order grouped into levels of mutually-independent nodes. */
  private levels: readonly (readonly string[])[] = [];
  private accruedNanoUsd = 0n;
  /**
   * The subset of `accruedNanoUsd` a rejected value took with it: spend on a
   * provider call that succeeded and whose output never committed, so it bills
   * nothing and the platform absorbs it. Run-scoped because the record it feeds
   * is one per run, never one per node.
   */
  private absorbedByRejectionNanoUsd = 0n;
  /**
   * One per-generation billing record per successful modelCall, keyed for
   * content pairing (single-settlement: charges materialize only at
   * settlement). Handed to the settlement hook on both the success and the
   * stopped-partial paths.
   */
  private readonly charges: SettlementCharge[] = [];
  private limitNanoUsd = 0n;
  /** The spend gate's first closer; the gate is open while this is undefined. */
  private closedBy: SpendGateCause | FlowAbortReason | undefined;
  private readonly drainAtMs: number;
  private streamSequence = 0;

  constructor(
    private readonly deps: WorkflowExecutorDeps,
    private readonly request: FlowStartRequest
  ) {
    this.store = createValueStore(deps.valueBudgetBytes ?? VALUE_STORE_BYTE_BUDGET_BYTES);
    this.schemaRegistry = {
      resolveSchema: (name) => deps.registries.constraints.resolve('schema', name)?.schema,
    };
    this.drainAtMs = deps.clock.now() + DEADLINE_CLASS_MS[request.definition.deadlineClass];
    this.admitted = new Promise<FlowAdmissionOutcome>((resolve) => {
      this.admittedResolve = resolve;
    });
  }

  /** Closes the spend gate; whatever is in flight runs on to its end. */
  stop(reason: FlowStopReason): void {
    this.closeGate(reason);
  }

  /**
   * Closes the spend gate and cuts whatever is in flight. It aborts even a gate
   * a drain already closed: a hard abort outranks a drain because it cuts the
   * in-flight step a drain would let finish.
   */
  abort(reason: FlowAbortReason): void {
    if (this.isOpen()) this.closedBy = reason;
    this.controller.abort();
  }

  /** Open until a closer closes it; the drain instant closes it lazily, on read. */
  isOpen(): boolean {
    if (this.closedBy === undefined && this.deps.clock.now() >= this.drainAtMs) {
      this.closedBy = 'deadline';
    }
    return this.closedBy === undefined;
  }

  private closeGate(cause: SpendGateCause): void {
    if (!this.isOpen()) return;
    this.closedBy = cause;
    if (cause === 'cost-circuit') this.captureCostCircuitTrip();
  }

  /** Counts spend toward the circuit, which closes the gate once it passes `hold × K`. */
  private accrue(costNanoUsd: bigint): void {
    this.accruedNanoUsd += costNanoUsd;
    if (this.accruedNanoUsd > this.limitNanoUsd) this.closeGate('cost-circuit');
  }

  /**
   * The admission decision, surfaced on the run handle (`FlowRunHandle.admitted`)
   * so the DO answers the start request synchronously and learns the hold
   * identity its terminal sink releases. Resolving twice is a harmless no-op
   * (promise semantics), which is what makes the post-`done` fallback safe.
   */
  resolveAdmitted(outcome: FlowAdmissionOutcome): void {
    this.admittedResolve(outcome);
  }

  /**
   * The post-`done` backstop: a defect that escaped before the admission
   * decision must still settle `admitted` or the DO's start request would hang.
   */
  settleAdmittedFromOutcome(outcome: FlowRunOutcome): void {
    this.admittedResolve({
      admitted: false,
      code: outcome.outcome === 'failed' ? outcome.code : ERROR_CODES.INTERNAL,
    });
  }

  /** A failure before the admission hook ran: the refusal code IS the failure code. */
  private failBeforeAdmission(failure: RunFailure): FlowRunOutcome {
    this.resolveAdmitted({ admitted: false, code: runFailureCode(failure) });
    return this.finalizeFailed(failure);
  }

  async run(): Promise<FlowRunOutcome> {
    const ingested = ingestRun({
      request: this.request,
      registries: this.deps.registries,
      schemaRegistry: this.schemaRegistry,
      storeInput: (name, channelValue) => {
        const stored = this.store.store(channelValue);
        if (stored.isErr()) return false;
        this.inputChannels.set(name, stored.value);
        return true;
      },
    });
    if (!('compiled' in ingested)) return this.failBeforeAdmission(ingested);
    this.compiled = ingested.compiled;
    this.childDriven = ingested.childDriven;
    this.levels = ingested.levels;
    const estimate = this.deps.estimateRun(this.request.definition);
    if (estimate.isErr()) {
      const wireCode = estimate.error.wireCode;
      return this.failBeforeAdmission({
        kind: 'inputs-invalid',
        ...(wireCode === undefined ? {} : { code: wireCode }),
      });
    }
    const decision = await this.request.hooks.admission({
      definition: this.request.definition,
      estimate: estimate.value.totalNanoUsd,
    });
    if (!decision.admitted) {
      this.resolveAdmitted({ admitted: false, code: decision.code });
      return this.finalizeFailed({ kind: 'admission-refused', code: decision.code });
    }
    // Resolved BEFORE the circuit-readout check: once the hook granted, a hold
    // may exist, and the terminal sink must learn its identity even when a
    // malformed grant fails the run one line later.
    this.resolveAdmitted({
      admitted: true,
      ...(decision.hold === undefined ? {} : { hold: decision.hold }),
    });
    const circuit = circuitReadoutOf(decision);
    if (circuit === undefined) {
      this.deps.telemetry.warn(
        'workflow admission grant carried no circuit readout',
        this.runCorrelation()
      );
      // A grant is minted by our own admission hook, so one without a circuit
      // readout is a hook defect, not a domain outcome. Only `captureError`
      // feeds Sentry; the message is a content-free compile-time literal (the
      // runId rides the warn above, never the capture).
      this.deps.telemetry.captureError(
        new Error('workflow admission grant carried no circuit readout'),
        FINGERPRINT_CODES.workflowAdmissionGrantMalformed
      );
      return this.finalizeFailed({ kind: 'defect' });
    }
    this.limitNanoUsd = circuit.costCircuitLimitNanoUsd;
    return this.walk();
  }

  // A closed gate starts no value node, level or loop iteration and cuts nothing
  // in flight, so the circuit bounds a run's spend at `hold × K` plus whatever
  // the node executions in flight when it closes spend before they next consult
  // the gate. Up to `LEVEL_STREAM_CONCURRENCY` of a level's nodes stream at once,
  // and a fan-out among them runs every branch at once, so the executions in
  // flight include every branch of each fan-out streaming. The `hold` already
  // scales with the declared fan-out width, so the bound stays
  // admission-proportional.
  private async walk(): Promise<FlowRunOutcome> {
    // A stop that landed before the walk began stops the run even when there is
    // no level for the per-level check to refuse.
    if (!this.isOpen()) return this.finalizeStopped();
    for (const level of this.levels) {
      // Skipped/child-driven nodes never execute and consume no boundary check;
      // an all-inert level is a no-op, exactly as a sequential walk skips them.
      const executable = level.filter((nodeId) => this.isExecutable(nodeId));
      if (executable.length === 0) continue;
      if (!this.isOpen()) return this.finalizeStopped();
      const resolution = await this.runLevel(executable);
      if (resolution?.kind === 'outcome') return resolution.outcome;
      if (resolution?.kind === 'end') break;
    }
    return this.finalizeSuccess();
  }

  private isExecutable(nodeId: string): boolean {
    return !this.childDriven.has(nodeId) && !this.skipped.has(nodeId);
  }

  /**
   * Streams a level's independent nodes concurrently (bounded), then applies
   * each in topological order — value-node charges and channel writes land in
   * declaration order regardless of which stream finished first, so a
   * multi-model turn's per-sibling charges pair with the right content.
   */
  private async runLevel(nodeIds: readonly string[]): Promise<LevelResolution | undefined> {
    this.store.setConcurrencyCeiling(levelInFlightWidth(nodeIds, (id) => this.compiledNode(id)));
    const produced = await mapWithConcurrency(nodeIds, LEVEL_STREAM_CONCURRENCY, (nodeId) =>
      this.produceNode(this.compiledNode(nodeId))
    );
    // EVERY item applies before the level resolves. Returning on the first
    // terminal step would make survival depend on declaration order: a sibling
    // that had already finished when a stop landed on an earlier one would lose
    // its committed answer and its charge together, which is the one thing the
    // documented stop behavior promises it keeps.
    const steps = produced.map((item) => this.applyProduced(item));
    return this.resolveLevel(steps);
  }

  /**
   * The level's terminal step, by the same precedence `runFanOut` resolves its
   * branches with: stopped > failure. The end sentinel resolves last because it
   * is ordinary control flow — the walk stops advancing and the run finalizes
   * successfully — so any terminal condition raised on the same level outranks
   * it.
   */
  private async resolveLevel(steps: readonly NodeStep[]): Promise<LevelResolution | undefined> {
    if (steps.some((step) => step.kind === 'stopped')) {
      return { kind: 'outcome', outcome: await this.finalizeStopped() };
    }
    const failed = steps.find(
      (step): step is NodeStep & { kind: 'failed' } => step.kind === 'failed'
    );
    if (failed !== undefined) {
      return { kind: 'outcome', outcome: this.finalizeFailed(failed.failure) };
    }
    if (steps.some((step) => step.kind === 'end')) return { kind: 'end' };
    return undefined;
  }

  /**
   * Runs one top-level node. Value nodes defer their state application (final
   * cost, charge, channel write) to `applyProduced` so a whole level applies in order;
   * control nodes self-apply here (their side effects touch only their own
   * channel and later-level targets, never a same-level sibling).
   */
  private async produceNode(compiledNode: CompiledNode): Promise<Produced> {
    const node = compiledNode.node;
    if (isValueNode(node)) {
      const produced = await this.produceValue(compiledNode, node, this.rootScope);
      if (produced.kind === 'step') return { kind: 'step', step: produced.step };
      return { kind: 'value', compiledNode, node, executed: produced.executed };
    }
    return { kind: 'step', step: await this.executeNode(compiledNode, this.rootScope) };
  }

  private applyProduced(item: Produced): NodeStep {
    if (item.kind === 'step') return item.step;
    return this.applyValueResult(
      { compiledNode: item.compiledNode, node: item.node, scope: this.rootScope },
      item.executed
    );
  }

  /**
   * `chargeKey` overrides the key a produced charge is tagged with — set only
   * for a fanOut body (the node id + branch element index) so N multi-model
   * branches map to N content items. Undefined on the main walk and loop
   * iterations, where a charge is keyed by the producing node id alone.
   */
  private async executeNode(
    compiledNode: CompiledNode,
    scope: Scope,
    chargeKey?: string
  ): Promise<NodeStep> {
    const node = compiledNode.node;
    return match(node)
      .with({ type: 'modelCall' }, (valueNode) =>
        this.runValueNode(compiledNode, valueNode, scope, chargeKey)
      )
      .with({ type: 'transform' }, (valueNode) =>
        this.runValueNode(compiledNode, valueNode, scope, chargeKey)
      )
      .with({ type: 'subWorkflow' }, (valueNode) =>
        this.runValueNode(compiledNode, valueNode, scope, chargeKey)
      )
      .with({ type: 'smartModel' }, (valueNode) =>
        this.runValueNode(compiledNode, valueNode, scope, chargeKey)
      )
      .with({ type: 'branch' }, (branchNode) =>
        Promise.resolve(this.runBranch(compiledNode, branchNode, scope))
      )
      .with({ type: 'fanIn' }, (fanInNode) =>
        Promise.resolve(this.runFanIn(compiledNode, fanInNode, scope))
      )
      .with({ type: 'fanOut' }, (fanOutNode) => this.runFanOut(compiledNode, fanOutNode, scope))
      .with({ type: 'loop' }, (loopNode) => this.runLoop(compiledNode, loopNode, scope))
      .exhaustive();
  }

  private async runValueNode(
    compiledNode: CompiledNode,
    node: ValueNode,
    scope: Scope,
    chargeKey?: string
  ): Promise<NodeStep> {
    const produced = await this.produceValue(compiledNode, node, scope);
    if (produced.kind === 'step') return produced.step;
    return this.applyValueResult({ compiledNode, node, scope, chargeKey }, produced.executed);
  }

  /** Resolves inputs and invokes the node's execution — the streaming happens here. */
  private async produceValue(
    compiledNode: CompiledNode,
    node: ValueNode,
    scope: Scope
  ): Promise<ProducedValue> {
    const resolved = this.resolveLiveInputs(compiledNode, scope);
    if (resolved === undefined) return { kind: 'step', step: { kind: 'ok' } };
    // Every value node starts here, one queued behind the level's stream pool and
    // a fan-out branch included, so a closed gate refuses it before it spends.
    if (!this.isOpen()) return { kind: 'step', step: { kind: 'stopped' } };
    const execution = this.deps.execution.resolveExecution(node);
    if (execution === undefined) {
      return { kind: 'step', step: this.unregisteredDefect() };
    }
    // Streaming is withheld from any node whose output is CONSUMED rather than
    // displayed (`docs/BILLING.md` §Reasoning Effort 6): a classifier is an
    // ordinary model call, and without this it would emit its routing internals
    // into the user's conversation. The disposition is read off the compiled
    // consumed set — the same value that decides which outputs settlement
    // persists — so it cannot contradict what the definition already fixes, the
    // way a declared per-node flag could.
    // The turn's classifier is derived from the graph the same way — the
    // decision reducer reading this call's answer IS what makes it the
    // classifier — and what follows from it is a withholding, not a flag: the
    // client's conversation context never reaches a routing call, so the
    // request cannot bill input the classifier reserve did not price.
    const ledger = openSpendLedger({
      isOpen: () => this.isOpen(),
      accrue: (costNanoUsd) => {
        this.accrue(costNanoUsd);
      },
    });
    const context = this.nodeContext(
      node.id,
      ledger.gate,
      execution.streaming && !this.compiled.consumedProducers.has(node.id),
      isTurnClassifierNode(node, this.request.definition.nodes)
    );
    const invoked = await this.invoke(node, scope, () => execution.run(node, resolved, context));
    if (invoked.kind === 'thrown') {
      return { kind: 'step', step: this.isOpen() ? invoked.step : { kind: 'stopped' } };
    }
    return {
      kind: 'executed',
      executed: {
        result: invoked.result,
        drained: !this.isOpen(),
        settleSpend: ledger.settle,
      },
    };
  }

  /** Runs a node execution, turning a throw into the step the node ends in. */
  private async invoke(
    node: ValueNode,
    scope: Scope,
    run: () => Promise<Result<NodeRunSuccess, NodeRunError>>
  ): Promise<
    | { readonly kind: 'returned'; readonly result: Result<NodeRunSuccess, NodeRunError> }
    | { readonly kind: 'thrown'; readonly step: NodeStep }
  > {
    try {
      return { kind: 'returned', result: await run() };
    } catch (error) {
      // A media download that would exceed the slice this node reserved from the
      // ValueStore aborts before the artifact materializes; the video adapter
      // surfaces it as an error named 'DownloadByteCapExceeded'. It is an
      // expected validation refusal, not a defect, so it never reaches Sentry —
      // and it is THIS NODE's failure, not the run's: the cap it breached is a
      // share of the budget sized to the level's width, so the run may hold
      // ample room for the siblings still downloading. That is why it takes the
      // declared `onError` path like any other node failure — a media turn's
      // `skip`-declared sibling skips its branch and the successful subset
      // settles, where failing the level here would discard generations already
      // paid for. The run-budget refusals elsewhere are the other case: `store()`
      // refusing a value means the whole run cannot hold it.
      if (isDownloadByteCapExceeded(error)) {
        return {
          kind: 'thrown',
          step: applyNodeFailure(this.store, node, scope, ERROR_CODES.VALIDATION),
        };
      }
      // A dependency this node needed did not answer — the chat file-part
      // mapper rethrows the rejection it recorded on its next invocation.
      // Unavailability is not a defect: the run fails UNAVAILABLE, and the
      // outage reaches an operator through the shared rule.
      if (error instanceof InfrastructureUnavailableError) {
        return {
          kind: 'thrown',
          step: { kind: 'failed', failure: this.infrastructureUnavailable(error) },
        };
      }
      this.deps.telemetry.captureError(
        error instanceof Error ? error : new Error(String(error)),
        FINGERPRINT_CODES.workflowNodeDefect
      );
      return { kind: 'thrown', step: FAILED_DEFECT };
    }
  }

  /**
   * Counts, commits, and charges a produced value — the only ordered mutation.
   * A drained node — one that returned after the gate closed — still commits
   * and bills its value, and its step is `stopped`.
   */
  private applyValueResult(target: ValueTarget, executed: ExecutedValue): NodeStep {
    const { compiledNode, node, scope, chargeKey } = target;
    const { result, drained, settleSpend } = executed;
    if (result.isErr()) {
      // A failed node's cost is what its execution reported, which can be less
      // than it spent: a model call reports only the charges of its returned
      // tool calls, never its model steps' cost, so an absent or partial figure
      // means no model-step spend was reported, not that none occurred. The
      // shortfall under-counts the circuit, so the gate closes later; it is
      // never a user over-bill, since a failed node charges nothing.
      settleSpend(result.error.costNanoUsd ?? 0n);
      if (drained) return { kind: 'stopped' };
      return applyNodeFailure(this.store, node, scope, result.error.reason);
    }
    // COUNTING STAYS ABOVE THE COMMIT. Only BILLING is gated on the value
    // committing (below); the spend counts toward the circuit whatever becomes
    // of the value, because the money left the platform either way. Moving this
    // line into the committed branch to match the charge looks like tidying and
    // is not: a model returning malformed output would then cost real provider
    // money on every attempt while contributing nothing to the circuit that
    // exists to stop that, so exposure would stop being bounded by `hold × K`.
    // Absorbed-but-counted is the intended asymmetry, and it is pinned in
    // `interpreter.test.ts` ("counts an uncommitted generation's spend toward
    // the circuit").
    settleSpend(finalCostOf(result.value));
    // BILLABLE ⟺ THE VALUE WAS COMMITTED, and this ordering is the whole
    // guarantee: charge after the commit, only on success. A generation whose
    // provider call succeeded but whose value fails `commitValue`'s runtime
    // `zodFor(out)` gate is not in the successful subset settlement bills
    // (`docs/BILLING.md` §Multi-Model 4) — a rejected output is our schema or a
    // malformed model return, so the spend is absorbed as platform loss.
    // Charging first made that unbillable spend billable the moment a run-level
    // anchor existed to attach it to, and a `skip`-declared sibling reaches it
    // without failing the run.
    const commit = this.commitValue(compiledNode, node, scope, result.value.value);
    if (commit.committed) collectCharge(this.charges, chargeKey ?? node.id, result.value);
    else this.absorbedByRejectionNanoUsd += result.value.costNanoUsd;
    return drained ? { kind: 'stopped' } : commit.step;
  }

  /**
   * Output validation is THE runtime type check: zodFor over the declared tag.
   *
   * `committed` says whether the value reached its channel, which a `NodeStep`
   * alone cannot: a `skip`-declared node whose output failed validation also
   * yields `ok`, and telling those apart is what keeps an unaccepted
   * generation's spend unbilled.
   */
  private commitValue(
    compiledNode: CompiledNode,
    node: Node,
    scope: Scope,
    value: unknown
  ): CommitOutcome {
    if (!zodFor(compiledNode.out, this.schemaRegistry).safeParse(value).success) {
      // A rejected value is an EXPECTED domain failure, not an outage: the
      // value's author answered and what it produced failed our declared port
      // schema. The code names that fault plainly rather than borrowing
      // UNAVAILABLE, which told the user to retry against a provider that was
      // fine. Which fault it names follows from WHOSE value was rejected
      // ({@link commitsModelReply}): a model's reply blames the model, and a
      // value produced from code we authored — the fanIn and fanOut joins, a
      // transform, a subWorkflow — blames the definition. Either mislabel is
      // the same defect, only pointing in opposite directions.
      return {
        committed: false,
        step: applyNodeFailure(
          this.store,
          node,
          scope,
          commitsModelReply(node)
            ? ERROR_CODES.MODEL_OUTPUT_INVALID
            : ERROR_CODES.WORKFLOW_DEFINITION_INVALID
        ),
      };
    }
    if (!storeInChannel(this.store, scope, node.id, value)) {
      return {
        committed: false,
        step: { kind: 'failed', failure: { kind: 'byte-budget-exceeded' } },
      };
    }
    return { committed: true, step: { kind: 'ok' } };
  }

  private runBranch(
    compiledNode: CompiledNode,
    node: Extract<Node, { type: 'branch' }>,
    scope: Scope
  ): NodeStep {
    const resolved = this.resolveLiveInputs(compiledNode, scope);
    if (resolved === undefined) return { kind: 'ok' };
    const predicate = this.deps.execution.resolvePredicate(node.predicate);
    if (predicate === undefined) {
      return this.unregisteredDefect();
    }
    const verdict = predicate(resolved[0]);
    if (typeof verdict !== 'string') {
      this.deps.telemetry.warn(
        'workflow branch verdict was not a case label',
        this.runCorrelation()
      );
      this.deps.telemetry.captureError(
        new Error('workflow branch verdict was not a case label'),
        FINGERPRINT_CODES.workflowPredicateContractBroken
      );
      return FAILED_DEFECT;
    }
    // Own-property guard: a branch verdict is model-influenceable, and a bare
    // lookup returns inherited Object.prototype members ('constructor',
    // '__proto__', 'hasOwnProperty', …) as spurious case hits — a bare `??`
    // never falls through to `else`, so every declared target dead-paths and
    // the run finalizes SUCCEEDED with empty outputs. Only a declared own case
    // may divert from `else`.
    const chosen = Object.hasOwn(node.cases, verdict) ? node.cases[verdict] : node.else;
    for (const target of new Set([...Object.values(node.cases), node.else])) {
      if (target !== chosen && (target as string) !== (END_NODE_ID as string)) {
        this.skipped.add(target);
      }
    }
    if (!storeInChannel(this.store, scope, node.id, resolved[0])) {
      return { kind: 'failed', failure: { kind: 'byte-budget-exceeded' } };
    }
    if ((chosen as string) === (END_NODE_ID as string)) return { kind: 'end' };
    return { kind: 'ok' };
  }

  private runFanIn(
    compiledNode: CompiledNode,
    node: Extract<Node, { type: 'fanIn' }>,
    scope: Scope
  ): NodeStep {
    const resolved = this.resolveLiveInputs(compiledNode, scope);
    if (resolved === undefined) return { kind: 'ok' };
    const reducer = this.deps.execution.resolveReducer(node.reducer);
    if (reducer === undefined) {
      return this.unregisteredDefect();
    }
    // A fanIn produces no billable generation, so only its step matters here.
    return this.commitValue(compiledNode, node, scope, reducer(resolved)).step;
  }

  private async runFanOut(
    compiledNode: CompiledNode,
    node: Extract<Node, { type: 'fanOut' }>,
    scope: Scope
  ): Promise<NodeStep> {
    const resolved = this.resolveLiveInputs(compiledNode, scope);
    if (resolved === undefined) return { kind: 'ok' };
    const elements = resolved[0] as readonly unknown[];
    if (elements.length > node.maxWidth) {
      // A collection wider than the compiled cap is a fault in the definition
      // we authored, never the provider's — so it carries the definition code
      // rather than falling through to UNAVAILABLE.
      return applyNodeFailure(this.store, node, scope, ERROR_CODES.WORKFLOW_DEFINITION_INVALID);
    }
    const body = this.compiledNode(node.body);
    const branches = await Promise.all(
      elements.map((element, index) => this.runFanBranch(node, body, { element, index }, scope))
    );
    const failed = branches.find(
      (outcome): outcome is { step: NodeStep & { kind: 'failed' }; value: unknown } =>
        outcome.step.kind === 'failed'
    );
    // A stopped branch outranks a failed one, as on a level: the run stops and
    // its partial settles.
    if (branches.some((outcome) => outcome.step.kind === 'stopped')) return { kind: 'stopped' };
    if (failed !== undefined) return failed.step;
    // A fanOut's own value is the joined branch list, not a billable generation
    // (each branch charged inside its own body), so only its step matters here.
    return this.commitValue(
      compiledNode,
      node,
      scope,
      branches.map((outcome) => outcome.value)
    ).step;
  }

  private async runFanBranch(
    node: Extract<Node, { type: 'fanOut' }>,
    body: CompiledNode,
    branch: { readonly element: unknown; readonly index: number },
    scope: Scope
  ): Promise<{ step: NodeStep; value: unknown }> {
    const element = this.store.store(branch.element);
    if (element.isErr()) {
      return {
        step: { kind: 'failed', failure: { kind: 'byte-budget-exceeded' } },
        value: undefined,
      };
    }
    const branchScope: Scope = {
      channels: new Map(),
      virtual: new Map([[virtualKey(node.id, FAN_OUT_ELEMENT_PORT_ID), element.value]]),
      parent: scope,
    };
    // A per-branch charge key pairs each branch's generation to its own
    // content item (N multi-model branches → N content items).
    const step = await this.executeNode(
      body,
      branchScope,
      `${body.node.id}#${String(branch.index)}`
    );
    // The end sentinel inside a fan branch ends that branch, not the run:
    // the branch's passthrough value is already in its scope.
    const localized: NodeStep = step.kind === 'end' ? { kind: 'ok' } : step;
    return { step: localized, value: readChannel(this.store, branchScope, body.node.id) };
  }

  private async runLoop(
    compiledNode: CompiledNode,
    node: Extract<Node, { type: 'loop' }>,
    scope: Scope
  ): Promise<NodeStep> {
    const resolved = this.resolveLiveInputs(compiledNode, scope);
    if (resolved === undefined) return { kind: 'ok' };
    const predicate = this.deps.execution.resolvePredicate(node.until);
    if (predicate === undefined) {
      return this.unregisteredDefect();
    }
    const body = this.compiledNode(node.body);
    let state = resolved[0];
    for (let iteration = 0; iteration < node.maxIterations; iteration += 1) {
      const gate = this.loopGate(predicate, state);
      if (gate.action === 'break') break;
      if (gate.action === 'terminal') return gate.step;
      const iterated = await this.runLoopIteration(node, body, scope, state);
      if (iterated.step !== undefined) return iterated.step;
      state = iterated.state;
    }
    if (!storeInChannel(this.store, scope, node.id, state)) {
      return { kind: 'failed', failure: { kind: 'byte-budget-exceeded' } };
    }
    return { kind: 'ok' };
  }

  /** Every iteration consults the spend gate before the condition. */
  private loopGate(predicate: RegisteredPredicate, state: unknown): LoopGate {
    if (!this.isOpen()) return { action: 'terminal', step: { kind: 'stopped' } };
    const verdict = predicate(state);
    if (typeof verdict !== 'boolean') {
      this.deps.telemetry.warn('workflow loop condition was not a boolean', this.runCorrelation());
      // Shares the branch-verdict fingerprint: a registered predicate returning
      // a value outside its declared type is one broken contract with one fix
      // and one owner, and two codes would split it across two Sentry groups.
      this.deps.telemetry.captureError(
        new Error('workflow loop condition was not a boolean'),
        FINGERPRINT_CODES.workflowPredicateContractBroken
      );
      return { action: 'terminal', step: FAILED_DEFECT };
    }
    return verdict ? { action: 'break' } : { action: 'iterate' };
  }

  private async runLoopIteration(
    node: Extract<Node, { type: 'loop' }>,
    body: CompiledNode,
    scope: Scope,
    state: unknown
  ): Promise<{ readonly step?: NodeStep; readonly state: unknown }> {
    const seed = this.store.store(state);
    if (seed.isErr()) {
      return { step: { kind: 'failed', failure: { kind: 'byte-budget-exceeded' } }, state };
    }
    const iterationScope: Scope = {
      channels: new Map(),
      virtual: new Map([[virtualKey(node.id, LOOP_STATE_PORT_ID), seed.value]]),
      parent: scope,
    };
    const step = await this.executeNode(body, iterationScope);
    if (step.kind !== 'ok') return { step, state };
    // A skip-on-error iteration keeps the previous state; the bound still
    // terminates the loop.
    return { state: readChannel(this.store, iterationScope, body.node.id) ?? state };
  }

  /**
   * Resolves declared inputs; undefined means a required feed comes from an
   * untaken path, so the node itself joins the skipped set (dead-path
   * propagation).
   */
  private resolveLiveInputs(compiledNode: CompiledNode, scope: Scope): unknown[] | undefined {
    const values: unknown[] = [];
    for (const feed of feedsInPortOrder(compiledNode)) {
      const resolution = this.resolveFeed(feed, scope);
      if (resolution.kind === 'dead') {
        this.skipped.add(compiledNode.node.id);
        return undefined;
      }
      values.push(resolution.value);
    }
    return values;
  }

  /** A definition naming an unregistered implementation is a wiring defect. */
  private unregisteredDefect(): NodeStep {
    this.deps.telemetry.warn(
      'workflow definition names an unregistered runtime implementation',
      this.runCorrelation()
    );
    this.deps.telemetry.captureError(
      new Error('workflow definition names an unregistered runtime implementation'),
      FINGERPRINT_CODES.workflowUnregisteredImplementation
    );
    return FAILED_DEFECT;
  }

  private resolveFeed(
    feed: CompiledNodeInput,
    scope: Scope
  ): { readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'dead' } {
    if (feed.from.node === WORKFLOW_INPUT_NODE_ID) {
      return { kind: 'value', value: this.store.resolve(this.inputChannels.get(feed.from.port)) };
    }
    const key = virtualKey(feed.from.node, feed.from.port);
    for (let current: Scope | undefined = scope; current !== undefined; current = current.parent) {
      if (current.virtual.has(key)) {
        return { kind: 'value', value: this.store.resolve(current.virtual.get(key)) };
      }
      if (current.channels.has(feed.from.node)) {
        return { kind: 'value', value: readChannel(this.store, current, feed.from.node) };
      }
    }
    // The producer never ran: it sits on a branch path the run did not take.
    if (feed.tag.kind === 'optional') return { kind: 'value', value: undefined };
    return { kind: 'dead' };
  }

  private nodeContext(
    nodeId: string,
    spend: SpendGate,
    streaming: boolean,
    routingOnly = false
  ): NodeRunContext {
    const mapper = this.request.mapFilePartFor?.(nodeId);
    const base = {
      values: this.store,
      clock: this.deps.clock,
      rng: this.deps.rng,
      signal: this.controller.signal,
      spend,
      ...clientContextFor(this.request, routingOnly),
      ...(mapper === undefined ? {} : { mapFilePart: mapper }),
    };
    if (!streaming) return base;
    const streamId = `${nodeId}#${String(this.streamSequence)}`;
    this.streamSequence += 1;
    let cursor = 1;
    return {
      ...base,
      emit: (event): void => {
        this.request.emit({ streamId, cursor, event });
        cursor += 1;
      },
    };
  }

  /**
   * Run outputs: values of sink nodes — nodes no dataflow edge consumes
   * (virtual body feeds excluded), bodies and control nodes aside.
   */
  private sinkOutputs(): Record<string, ContentValue> {
    const consumed = this.compiled.consumedProducers;
    // Null-prototype accumulator: a NodeId is any non-empty string, so a node
    // named '__proto__' (or another reserved prototype name) would set this
    // object's prototype instead of an own key on a plain `{}`, silently
    // dropping its billable output from settlement. Keyed as pure data here.
    const outputs = Object.create(null) as Record<string, ContentValue>;
    for (const nodeId of this.compiled.order) {
      if (!this.isSink(nodeId, consumed)) continue;
      const value = readChannel(this.store, this.rootScope, nodeId);
      if (value !== undefined) outputs[nodeId] = contentValueOf(value);
    }
    return outputs;
  }

  private isSink(nodeId: string, consumed: ReadonlySet<string>): boolean {
    return (
      !consumed.has(nodeId) &&
      !this.childDriven.has(nodeId) &&
      this.compiledNode(nodeId).node.type !== 'branch'
    );
  }

  private async settle(outputs: Record<string, ContentValue>): Promise<RunFailure | undefined> {
    try {
      await this.request.hooks.settlement({
        runKey: this.request.runKey,
        outputs,
        charges: this.charges,
      });
      return undefined;
    } catch (error) {
      // An all-branches-failed turn — no branch produced content the turn could
      // persist — is a real "providers unavailable" outcome, not an engine
      // defect: the chat settlement hook signals it by throwing the typed
      // AllBranchesFailedError sentinel (imported intra-slice from ./failures —
      // never from the chat slice, which depends on the engine). It reroutes to
      // UNAVAILABLE and is never captured to Sentry; every other throw is a
      // genuine defect.
      if (error instanceof AllBranchesFailedError) {
        return { kind: 'all-branches-failed' };
      }
      // A dependency settlement needed did not answer — whatever the settling
      // transaction could not complete, it proved nothing either way, so the
      // user is told the system is down rather than that their state conflicts.
      if (error instanceof InfrastructureUnavailableError) {
        return this.infrastructureUnavailable(error);
      }
      if (error instanceof SettlementConflictError) return this.settlementRefusal(error);
      this.deps.telemetry.captureError(
        error instanceof Error ? error : new Error(String(error)),
        FINGERPRINT_CODES.workflowSettlementDefect
      );
      return { kind: 'defect' };
    }
  }

  /**
   * Routes a rejection carrying {@link InfrastructureUnavailableError}: UNAVAILABLE
   * to the caller, one Sentry group for the operator. Every catch site that
   * discriminates that class comes through here, so they cannot drift into one
   * that captures and one that does not.
   */
  private infrastructureUnavailable(error: InfrastructureUnavailableError): RunFailure {
    this.deps.telemetry.captureError(error, FINGERPRINT_CODES.workflowInfraUnavailable);
    return { kind: 'infrastructure-unavailable' };
  }

  private async finalizeSuccess(): Promise<FlowRunOutcome> {
    const failure = await this.settle(this.sinkOutputs());
    if (failure !== undefined) return this.finalizeFailed(failure);
    return { outcome: 'succeeded' };
  }

  /**
   * A run whose gate closed before its walk ended settles what it produced,
   * whichever closer closed it; a stopped run with no output settles nothing
   * and leaves zero committed effects (the hold TTLs out, the key-row lease
   * lapses).
   */
  private async finalizeStopped(): Promise<FlowRunOutcome> {
    const outputs = this.sinkOutputs();
    if (Object.keys(outputs).length > 0) {
      const failure = await this.settle(outputs);
      if (failure !== undefined) return this.finalizeFailed(failure);
    }
    return { outcome: 'stopped' };
  }

  /**
   * The correlation fields every structured log line this run writes carries.
   * The id is the one the caller minted for the run, never the client-supplied
   * `runKey`: `runId` is an allowlisted log field and that allowlist is what
   * makes user content unrepresentable on the channel, so an Idempotency-Key
   * emitted under it is caller input inside a field declared content-free
   * (`lib/telemetry/safe-log-fields.ts`). A caller that minted none — an
   * in-process executor double — leaves the line without the field rather than
   * substituting the key.
   */
  private runCorrelation(): { readonly runId?: string } {
    return this.request.runId === undefined ? {} : { runId: this.request.runId };
  }

  private finalizeFailed(failure: RunFailure): FlowRunOutcome {
    const code = runFailureCode(failure);
    this.deps.telemetry.warn('workflow run failed', {
      ...this.runCorrelation(),
      errorCode: code,
    });
    return { outcome: 'failed', code };
  }

  /**
   * The cost circuit closed the gate first: observed spend passed the admission
   * hold's `× K` limit. The run still settles what it produced; the event exists
   * because a crossing means the admission estimate was exceeded K-fold (a
   * systematically low estimate or abuse). The gate closes once, so a run raises
   * at most one, carrying only the DO-minted runId, the accrual and the limit
   * (no content, no PII), so a human can see which run overshot and by how much.
   */
  private captureCostCircuitTrip(): void {
    const event = costCircuitTripEvent({
      runId: this.request.runId,
      accruedNanoUsd: this.accruedNanoUsd,
      limitNanoUsd: this.limitNanoUsd,
    });
    this.deps.telemetry.captureError(event, FINGERPRINT_CODES.workflowCostCircuitTripped);
  }

  /**
   * Provider spend a rejected value absorbed: the call succeeded and was paid
   * for, its output failed `commitValue`'s schema gate or the byte budget, so
   * it never committed and therefore never bills. That is platform loss, and it
   * raises exactly one Sentry event per run, carrying only the DO-minted runId
   * and the absorbed nano-USD (no content, no PII), so a human on the Sentry
   * error channel — the signal's watcher — can see a model or a schema
   * systematically producing output we pay for and discard.
   *
   * ONE EVENT PER RUN, not one per node: a schema mismatch on a popular model
   * fans out across every sibling of a multi-model turn, and a per-node event
   * would flood the channel reserved for the unexpected.
   */
  captureAbsorbedRejectionLoss(): void {
    if (this.absorbedByRejectionNanoUsd === 0n) return;
    const event = absorbedLossEvent({
      name: 'RejectedOutputAbsorbed',
      summary: 'rejected node output absorbed spend',
      runId: this.request.runId,
      absorbedNanoUsd: this.absorbedByRejectionNanoUsd,
    });
    this.deps.telemetry.captureError(event, FINGERPRINT_CODES.workflowRejectedOutputAbsorbed);
  }

  /**
   * An expected settlement refusal, signalled by the settlement hook with the
   * typed SettlementConflictError and carrying a DomainError whose `wireCode`
   * override names the chat-specific client code. Not a defect: the code is
   * projected through `domainWireCode` and never captured as one. A refusal
   * nobody could be billed for is absorbed platform loss, which raises the one
   * absorbed-loss event its class raises per run.
   */
  private settlementRefusal(refusal: SettlementConflictError): RunFailure {
    if (refusal instanceof AbsorbedSettlementRefusal) {
      const event = absorbedLossEvent({
        name: 'SettlementRefusalAbsorbed',
        summary: 'settlement refusal absorbed spend',
        runId: this.request.runId,
        absorbedNanoUsd: this.charges.reduce((sum, charge) => sum + charge.billableCostNanoUsd, 0n),
      });
      this.deps.telemetry.captureError(event, FINGERPRINT_CODES.workflowRefusalAbsorbed);
    }
    return { kind: 'settlement-conflict', code: domainWireCode(refusal.domainError) };
  }

  private compiledNode(nodeId: NodeId | string): CompiledNode {
    const found = this.compiled.nodes.get(nodeId as string);
    /* v8 ignore next 5 -- unreachable after a clean compile: every ordered/referenced id registers a compiled node */
    if (found === undefined) {
      // Unreachable after a clean compile: every ordered/referenced id
      // registers a compiled node.
      throw new Error('workflow interpreter referenced a node the compile did not register');
    }
    return found;
  }
}

async function runContained(
  execution: RunExecution,
  deps: WorkflowExecutorDeps
): Promise<FlowRunOutcome> {
  try {
    return await execution.run();
  } catch (error) {
    deps.telemetry.captureError(
      error instanceof Error ? error : new Error(String(error)),
      FINGERPRINT_CODES.workflowRunDefect
    );
    return { outcome: 'failed', code: ERROR_CODES.INTERNAL };
  }
}

export function createWorkflowExecutor(deps: WorkflowExecutorDeps): FlowExecutor {
  return {
    start: (request: FlowStartRequest): FlowRunHandle => {
      const execution = new RunExecution(deps, request);
      const done = (async (): Promise<FlowRunOutcome> => {
        const outcome = await runContained(execution, deps);
        // The run has reached a terminal outcome by every route there is —
        // succeeded, stopped, failed, or a defect `runContained` turned into a
        // failure — which is what makes this the one place the absorbed-loss
        // record can fire exactly once. The three `finalize*` methods are not:
        // a rejected output leaves a SUCCEEDING run (a `skip`-declared sibling
        // reaches it without failing the turn), and two of them delegate to the
        // third when settlement fails.
        execution.captureAbsorbedRejectionLoss();
        // Backstop, not the primary path: `admitted` normally resolved at the
        // decision; a defect that escaped earlier settles it here (a second
        // resolve is a no-op) so the handle's promise can never hang.
        execution.settleAdmittedFromOutcome(outcome);
        return outcome;
      })();
      return {
        runKey: request.runKey,
        done,
        admitted: execution.admitted,
        stop: (reason: FlowStopReason): void => {
          execution.stop(reason);
        },
        abort: (reason: FlowAbortReason): void => {
          execution.abort(reason);
        },
      };
    },
  };
}
