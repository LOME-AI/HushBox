import { describe, expect, it } from 'vitest';
import { MAX_SELECTED_MODELS, jsonTag, textTag } from '@hushbox/shared';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import {
  TURN_DECISION_SCHEMA_NAME,
  buildWorkflow,
  modelCall,
  smartModel,
} from '../../../workflows/index.js';
import { snapshotResolver } from '../../../models/index.js';
import { createTurnCompileRegistries, turnClassifier } from './definition.js';
import { CHAT_CLASSIFIER_NODE_ID, CHAT_DECISION_NODE_ID, classifierStage } from './classifier.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_NODE_ID } from '../constants.js';
import type { CompileError, CompiledDefinition } from '../../../workflows/index.js';
import type { Result } from '../../../../lib/result/index.js';
import type { ModelDescriptor, Node, TypeTag } from '@hushbox/shared';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

/**
 * One classify → decide stage feeding a `smartModel` slot AND N `modelCall`
 * siblings in ONE definition. Both existing builders hang their consumers off
 * the same `decide.out` port, which makes the mixed shape look expressible;
 * this drives it through the real compiler instead, because "both builders read
 * the same port" is not the same claim as "the compiler accepts both consumers
 * on it at once".
 *
 * The graph is assembled from the published builders rather than by hand: a
 * hand-written definition object would prove that a shape parses, not that the
 * shape the turn builders can actually produce compiles.
 */

const CLASSIFIER_ENGINE = 'engine/classifier';
const SLOT_CANDIDATES = [
  { id: 'slot/candidate-a', description: 'a' },
  { id: 'slot/candidate-b', description: 'b' },
] as const;

function descriptorFor(id: string): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 1000 },
    pricing: tokenPricingFixture({ input: 2n, output: 3n }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

function siblingModelId(index: number): string {
  return `pinned/model-${String(index)}`;
}

/** Every id any case below wires, priced identically — the proof is about the
 * graph algebra, so nothing here should turn on one model being cheaper. */
function catalogFor(siblingCount: number): readonly ModelDescriptor[] {
  return [
    descriptorFor(CLASSIFIER_ENGINE),
    ...SLOT_CANDIDATES.map((candidate) => descriptorFor(candidate.id)),
    ...Array.from({ length: siblingCount }, (_, index) => descriptorFor(siblingModelId(index))),
  ];
}

interface MixedGraphOverrides {
  /** The tag each sibling declares on its single input port. */
  readonly siblingAccepts?: TypeTag;
  /** The node id each sibling takes, by index. */
  readonly siblingId?: (index: number) => string;
}

/**
 * Compiles the mixed definition through the same `buildWorkflow` →
 * `compileDefinition` path a real turn takes, over the same registries the
 * route builds (`createTurnCompileRegistries`), so compile and runtime read one
 * catalog snapshot.
 */
function compileMixedTurn(
  siblingCount: number,
  overrides: MixedGraphOverrides = {}
): Result<CompiledDefinition, CompileError[]> {
  const catalog = catalogFor(siblingCount);
  const { nodes, constraints } = createTurnCompileRegistries(snapshotResolver(catalog));
  const classifier = turnClassifier({
    engineId: CLASSIFIER_ENGINE,
    promptedModels: [...SLOT_CANDIDATES],
    effortOptions: [],
  });
  const stage = classifierStage(classifier.params);
  const slot = smartModel({
    id: CHAT_TURN_NODE_ID,
    classifierModelId: CLASSIFIER_ENGINE,
    candidates: [...SLOT_CANDIDATES],
    accepts: jsonTag(TURN_DECISION_SCHEMA_NAME),
    in: stage.decide.out,
  });
  const siblings = Array.from({ length: siblingCount }, (_, index) =>
    modelCall({
      // The multi-model builder's own sibling ids are the slot id suffixed by
      // index, so this is also the shape most at risk of colliding with the
      // slot's bare id.
      id: overrides.siblingId?.(index) ?? `${CHAT_TURN_NODE_ID}${String(index)}`,
      model: siblingModelId(index),
      accepts: overrides.siblingAccepts ?? jsonTag(TURN_DECISION_SCHEMA_NAME),
      in: stage.decide.out,
      produces: textTag(),
      optional: true,
      onError: 'skip',
    })
  );
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: CHAT_TURN_HOOKS,
    inputs: stage.inputs,
    nodes: [...stage.nodes, slot, ...siblings],
    registries: { nodes, constraints },
  });
}

function nodesOfType(definition: { readonly nodes: readonly Node[] }, type: Node['type']): Node[] {
  return definition.nodes.filter((node) => node.type === type);
}

describe('one classify/decide stage feeding a smartModel slot and modelCall siblings', () => {
  it('compiles a definition holding the slot and two pinned siblings on the one stage', () => {
    const compiled = compileMixedTurn(2);
    expect(compiled.isOk()).toBe(true);
  });

  it('keeps the closed node set closed: one smartModel, the classifier plus the siblings as modelCalls, one fanIn', () => {
    const { definition } = compileMixedTurn(2)._unsafeUnwrap();
    expect(nodesOfType(definition, 'smartModel').map((node) => node.id)).toEqual([
      CHAT_TURN_NODE_ID,
    ]);
    expect(nodesOfType(definition, 'modelCall').map((node) => node.id)).toEqual([
      CHAT_CLASSIFIER_NODE_ID,
      `${CHAT_TURN_NODE_ID}0`,
      `${CHAT_TURN_NODE_ID}1`,
    ]);
    expect(nodesOfType(definition, 'fanIn').map((node) => node.id)).toEqual([
      CHAT_DECISION_NODE_ID,
    ]);
    expect(new Set(definition.nodes.map((node) => node.type))).toEqual(
      new Set(['modelCall', 'fanIn', 'smartModel'])
    );
  });

  it('binds the decision to BOTH consumer kinds: the slot and every sibling read the one decide port', () => {
    const compiled = compileMixedTurn(2)._unsafeUnwrap();
    const decideOut = compiled.nodes.get(CHAT_DECISION_NODE_ID);
    if (decideOut === undefined) throw new Error('the stage lost its decision node');
    const consumers = [CHAT_TURN_NODE_ID, `${CHAT_TURN_NODE_ID}0`, `${CHAT_TURN_NODE_ID}1`];
    for (const id of consumers) {
      const inputs = compiled.nodes.get(id)?.inputs;
      const fed = [...(inputs?.values() ?? [])];
      expect(fed).toHaveLength(1);
      expect(fed[0]?.from).toEqual({
        node: CHAT_DECISION_NODE_ID,
        port: decideOut.node.out,
      });
      // The typed-edge algebra's exact-equality rule for named json: the
      // decision envelope reaches a slot and a sibling under the same tag.
      expect(fed[0]?.tag).toEqual(jsonTag(TURN_DECISION_SCHEMA_NAME));
    }
  });

  it('leaves the slot and every sibling a sink, so settlement persists all three answers', () => {
    const compiled = compileMixedTurn(2)._unsafeUnwrap();
    const sinks = compiled.definition.nodes
      .map((node) => node.id)
      .filter((id) => !compiled.consumedProducers.has(id));
    expect(sinks).toEqual([CHAT_TURN_NODE_ID, `${CHAT_TURN_NODE_ID}0`, `${CHAT_TURN_NODE_ID}1`]);
  });

  it('compiles the widest selection the wire admits alongside the slot', () => {
    // The wire's source cap counts every kind, the slot included, so the widest
    // admitted mixed selection is one sibling short of the cap.
    expect(compileMixedTurn(MAX_SELECTED_MODELS - 1).isOk()).toBe(true);
  });
});

describe('what bounds the sibling count in a mixed turn', () => {
  // The compile-time ceiling on the mixed shape is the node count, NOT fan-out
  // width: the siblings are static nodes, so no `fanOut` node exists for
  // `maxFanOutWidth` to bound. Product policy (`MAX_SELECTED_MODELS`) binds long
  // before either.
  const CEILING_NODES = 64;
  const STAGE_AND_SLOT_NODES = 3;

  it('compiles at the node ceiling', () => {
    expect(compileMixedTurn(CEILING_NODES - STAGE_AND_SLOT_NODES).isOk()).toBe(true);
  });

  it('rejects one sibling past the node ceiling, and on the node count alone', () => {
    const errors = compileMixedTurn(CEILING_NODES - STAGE_AND_SLOT_NODES + 1)._unsafeUnwrapErr();
    expect(errors.map((error) => error.code)).toEqual(['node_count_exceeded']);
  });
});

describe('the mixed compile discriminates — the malformed shapes it rejects', () => {
  it('rejects a sibling that declares text where the decision envelope arrives', () => {
    const errors = compileMixedTurn(1, { siblingAccepts: textTag() })._unsafeUnwrapErr();
    expect(errors.map((error) => error.code)).toEqual(['type_mismatch']);
  });

  it('rejects a sibling whose id collides with the slot', () => {
    const errors = compileMixedTurn(1, { siblingId: () => CHAT_TURN_NODE_ID })._unsafeUnwrapErr();
    expect(errors.map((error) => error.code)).toEqual(['duplicate_node_id']);
  });
});
