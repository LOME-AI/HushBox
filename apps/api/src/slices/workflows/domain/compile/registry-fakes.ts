import { z } from 'zod';
import {
  jsonTag,
  listTag,
  mediaTag,
  optionalTag,
  textTag,
  TURN_DECISION_REDUCER,
} from '@hushbox/shared';
import { portsAccepting } from '../engine/model-ports.js';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  createConstraintRegistry,
} from '../engine/workflow-capabilities.js';
import type {
  ConstraintEntryOf,
  ConstraintKind,
  NamedConstraintEntry,
  NamedConstraintRegistry,
  NodePortDeclaration,
  TypeTag,
} from '@hushbox/shared';
import type { CompileContext, NodeRegistryContext } from './context.js';

/**
 * Shared test doubles for the compile and builder suites — not production
 * wiring. The live registries are owned by the node-registry module; these
 * fakes pin a small, stable vocabulary the tests speak.
 */

export const CLASSIFICATION_SCHEMA_NAME = 'classification';

export const PNG = 'image/png';

/** The input tuple the shipped decision reducer is registered with. */
function liveDecisionReducerInputs(): readonly TypeTag[] {
  const entry = createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES).resolve(
    'reducer',
    TURN_DECISION_REDUCER
  );
  /* v8 ignore next -- the live capability set registers this reducer; its
     absence would fail every production classifier graph long before here */
  if (entry === undefined) throw new Error('the decision reducer is not registered');
  return entry.in;
}

export function makeFakeConstraints(): NamedConstraintRegistry {
  const entries: NamedConstraintEntry[] = [
    {
      kind: 'schema',
      name: CLASSIFICATION_SCHEMA_NAME,
      version: 1,
      schema: z.object({ label: z.string() }),
    },
    {
      kind: 'predicate',
      name: 'routeByLabel',
      version: 1,
      input: optionalTag(jsonTag(CLASSIFICATION_SCHEMA_NAME)),
    },
    { kind: 'predicate', name: 'textDone', version: 1, input: textTag() },
    {
      kind: 'predicate',
      name: 'labelDone',
      version: 1,
      input: jsonTag(CLASSIFICATION_SCHEMA_NAME),
    },
    {
      kind: 'reducer',
      name: 'captionsWithPrompt',
      version: 1,
      in: [listTag(optionalTag(textTag())), textTag()],
      out: textTag(),
    },
    { kind: 'reducer', name: 'pairJoin', version: 1, in: [textTag(), textTag()], out: textTag() },
    {
      // The REAL decision reducer's name and input signature: the classifier
      // derivation keys on the name and the compiler on the arity, so a fake
      // that restated either would test a graph shape production never
      // produces. The arity is READ from the live registration rather than
      // mirrored here — a mirrored tuple is what let this fake sit one input
      // behind production. The output stays the fakes' own schema vocabulary,
      // which is deliberately not production's.
      kind: 'reducer',
      name: TURN_DECISION_REDUCER,
      version: 1,
      in: liveDecisionReducerInputs(),
      out: jsonTag(CLASSIFICATION_SCHEMA_NAME),
    },
    {
      kind: 'reducer',
      name: 'classifyText',
      version: 1,
      in: [textTag()],
      out: jsonTag(CLASSIFICATION_SCHEMA_NAME),
    },
  ];
  return {
    resolve: <K extends ConstraintKind>(kind: K, name: string): ConstraintEntryOf<K> | undefined =>
      entries.find((entry) => entry.kind === kind && entry.name === name) as
        | ConstraintEntryOf<K>
        | undefined,
  };
}

const FAKE_MODEL_PORTS: Readonly<Record<string, NodePortDeclaration>> = {
  'answer-model': { in: [textTag()], out: textTag() },
  'hard-model': { in: [textTag()], out: textTag() },
  'first-model': { in: [textTag()], out: textTag() },
  'second-model': { in: [textTag()], out: textTag() },
  'third-model': { in: [textTag()], out: textTag() },
  'classifier-model': { in: [textTag()], out: jsonTag(CLASSIFICATION_SCHEMA_NAME) },
  'vision-model': { in: [mediaTag('image', [PNG])], out: textTag() },
  // Declares two inputs where modelCall's shape allows exactly one.
  'two-port-model': { in: [textTag(), textTag()], out: textTag() },
  'ghost-schema-model': { in: [textTag()], out: jsonTag('ghost') },
  // A malformed tag a registry could only produce through a defect upstream.
  'forged-tag-model': { in: [textTag()], out: { kind: 'json', schemaName: '' } },
};

const FAKE_TRANSFORM_PORTS: Readonly<Record<string, NodePortDeclaration>> = {
  caption: { in: [mediaTag('image', [PNG])], out: textTag() },
  echo: { in: [textTag()], out: textTag() },
  split: { in: [textTag()], out: listTag(textTag()) },
};

const FAKE_SUB_WORKFLOW_PORTS: Readonly<Record<string, NodePortDeclaration>> = {
  summarize: { in: [textTag(), textTag()], out: textTag() },
};

/** A fake model resolves for smartModel iff it is a known text→text model. */
function fakeTextModel(id: string): boolean {
  const ports = FAKE_MODEL_PORTS[id];
  return ports?.in.length === 1 && ports.in[0]?.kind === 'text' && ports.out.kind === 'text';
}

export function makeFakeNodeRegistry(): NodeRegistryContext {
  return {
    hasNode: (_type, version) => version === 1,
    resolveValuePorts: (node) => {
      if (node.type === 'modelCall') {
        const ports = FAKE_MODEL_PORTS[node.model];
        return ports === undefined ? undefined : portsAccepting(ports, node.inputSchema);
      }
      if (node.type === 'transform') return FAKE_TRANSFORM_PORTS[node.transform];
      if (node.type === 'smartModel') {
        const ids = [node.classifierModelId, ...node.candidates.map((candidate) => candidate.id)];
        return ids.every((id) => fakeTextModel(id))
          ? portsAccepting({ in: [textTag()], out: textTag() }, node.inputSchema)
          : undefined;
      }
      return FAKE_SUB_WORKFLOW_PORTS[node.ref];
    },
  };
}

export function makeFakeCompileContext(overrides: Partial<CompileContext> = {}): CompileContext {
  return {
    nodes: makeFakeNodeRegistry(),
    constraints: makeFakeConstraints(),
    workflowInputs: { prompt: textTag() },
    ...overrides,
  };
}
