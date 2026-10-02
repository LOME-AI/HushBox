import { ContentValue, END_NODE_ID, zodFor } from '@hushbox/shared';
import { compileDefinition } from '../compile/compile-definition.js';
import { WORKFLOW_INPUT_NODE_ID } from '../compile/conventions.js';
import { channelValueOf, inputTagOf } from './channel-values.js';
import type { FlowStartRequest, Node, SchemaNameRegistry, TypeTag } from '@hushbox/shared';
import type { CompiledDefinition } from '../compile/compile-definition.js';
import type { CompileContext } from '../compile/context.js';
import type { RunFailure } from './failures.js';

/**
 * The execution-ordering successors a node imposes beyond dataflow — a branch's
 * case/else targets and a fanOut/loop body. Level layering must honor these so
 * a branch's targets never share the branch's level (their skip is decided only
 * after the branch runs). Mirrors the compiler's own control-edge set.
 */
function controlTargetsOf(node: Node): readonly string[] {
  if (node.type === 'branch') {
    return [...Object.values(node.cases), node.else].filter(
      (target) => (target as string) !== (END_NODE_ID as string)
    );
  }
  if (node.type === 'fanOut' || node.type === 'loop') return [node.body as string];
  return [];
}

/** What a clean ingest hands the walk: the compiled plan and its level order. */
export interface RunPlan {
  readonly compiled: CompiledDefinition;
  readonly childDriven: ReadonlySet<string>;
  readonly levels: readonly (readonly string[])[];
}

/** Validates, tags, and byte-meters the supplied inputs — before admission. */
export function ingestRun(params: {
  readonly request: FlowStartRequest;
  readonly registries: Omit<CompileContext, 'workflowInputs'>;
  readonly schemaRegistry: SchemaNameRegistry;
  /**
   * Admits one supplied input into the run's channels, `false` when the byte
   * budget refuses it. Supplied by the interpreter because every value crosses
   * the ValueStore there, so the seam stays whole.
   */
  readonly storeInput: (name: string, channelValue: unknown) => boolean;
}): RunPlan | RunFailure {
  // Null-prototype accumulator: an input port name is any non-empty string,
  // so a port named '__proto__' would reparent a plain `{}` instead of adding
  // an own key, and inherited members ('__proto__', 'constructor', …) would
  // answer compile's `port in workflowInputs` existence check spuriously true
  // — silently masking a missing required input. Keyed as pure data here.
  const workflowInputs = Object.create(null) as Record<string, TypeTag>;
  for (const [name, supplied] of Object.entries(params.request.inputs)) {
    const parsed = ContentValue.safeParse(supplied);
    if (!parsed.success) return { kind: 'inputs-invalid' };
    const tag = inputTagOf(parsed.data);
    if (tag === undefined) return { kind: 'inputs-invalid' };
    const channelValue = channelValueOf(parsed.data);
    if (!zodFor(tag, params.schemaRegistry).safeParse(channelValue).success) {
      return { kind: 'inputs-invalid' };
    }
    if (!params.storeInput(name, channelValue)) return { kind: 'byte-budget-exceeded' };
    workflowInputs[name] = tag;
  }
  const compiled = compileDefinition(params.request.definition, {
    ...params.registries,
    workflowInputs,
  });
  if (compiled.isErr()) return { kind: 'inputs-invalid' };
  const childDriven = new Set(
    compiled.value.definition.nodes
      .filter((node) => node.type === 'fanOut' || node.type === 'loop')
      .map((node) => node.body as string)
  );
  return { compiled: compiled.value, childDriven, levels: levelsOf(compiled.value) };
}

/**
 * Groups the topological order into levels where every node's producers and
 * control parents sit in strictly earlier levels. Nodes sharing a level are
 * mutually independent, so the walk streams them concurrently.
 */
function levelsOf(compiled: CompiledDefinition): readonly (readonly string[])[] {
  const predecessors = predecessorsOf(compiled);
  const levelOf = new Map<string, number>();
  const buckets: string[][] = [];
  for (const id of compiled.order) {
    let level = 0;
    for (const dep of predecessors.get(id) ?? []) {
      level = Math.max(level, (levelOf.get(dep) ?? 0) + 1);
    }
    levelOf.set(id, level);
    const bucket = buckets[level] ?? [];
    buckets[level] = bucket;
    bucket.push(id);
  }
  return buckets;
}

/** The dataflow + control-edge predecessors of every node, by node id. */
function predecessorsOf(compiled: CompiledDefinition): ReadonlyMap<string, ReadonlySet<string>> {
  const predecessors = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string): void => {
    /* v8 ignore next -- unreachable: the compile validates every edge endpoint, so `to` is always a registered node */
    if (!compiled.nodes.has(to)) return;
    const set = predecessors.get(to) ?? new Set<string>();
    set.add(from);
    predecessors.set(to, set);
  };
  for (const compiledNode of compiled.nodes.values()) {
    for (const input of compiledNode.inputs.values()) {
      if (input.from.node === WORKFLOW_INPUT_NODE_ID) continue;
      addEdge(input.from.node, compiledNode.node.id);
    }
    for (const target of controlTargetsOf(compiledNode.node)) {
      addEdge(compiledNode.node.id, target);
    }
  }
  return predecessors;
}
