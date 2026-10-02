import { Node, SyntaxKind } from 'ts-morph';
import { failWith, isTestFile, relativePath, sourceFileAt } from '../lib/paths.js';
import type {
  ArrowFunction,
  CallExpression,
  FunctionExpression,
  Identifier,
  MethodDeclaration,
  ObjectLiteralExpression,
  SourceFile,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Doctrine (the admin slice's Reversibility Iron Law): an `ephemeral`-class op
 * may declare `inverse: null` because it leaves nothing durable behind, and the
 * obligation that makes the claim true is that its body MAKES NO CALL TAKING
 * THE SETTLEMENT TRANSACTION HANDLE. This is that obligation's checker.
 *
 * Without it the class is a convention: an op body that writes through
 * `ctx.tx` and calls itself ephemeral escapes the inverse requirement while
 * committing durable state, which is exactly the shape the Iron Law exists to
 * refuse. A durable effect the operator did not originate is the
 * `system-owned` class instead — it states its reason and still declares no
 * inverse, and this rule deliberately passes over it, because what makes that
 * class legitimate is whose obligation the effect is, not the absence of a
 * transaction.
 *
 * # what "makes no call taking the handle" is read as
 *
 * Following the handle through helper functions would need type resolution the
 * harness forbids, so the readable form is stronger and local: inside an
 * ephemeral op's `execute`, the context parameter may only be READ THROUGH a
 * property other than `tx`. It may not be handed to a call (a helper taking
 * the whole context reaches the handle out of sight, which is how a body
 * takes it without ever writing `.tx`), aliased, or destructured. A body
 * satisfying that cannot pass the handle anywhere, whatever it calls.
 *
 * # why the rule reads the declarations rather than a list of its own
 *
 * Scope is the `ephemeral` entries of the shared contract map plus any contract
 * an op module defines itself, resolved to the registrations that bind them. A rule carrying its own op list would pass over a renamed or
 * newly added ephemeral op in silence. Decay in its own subject is loud
 * instead: an unreadable contract map entry, contract argument, or `execute`
 * throws, and a declared-ephemeral contract the scanned tree binds to no body is
 * reported against the map line that declares it.
 */

const RULE = 'admin-ephemeral-ops-take-no-transaction';
const fail: (message: string) => never = failWith(RULE);

/** The settlement transaction handle's one name on the op context. */
const TRANSACTION_PROPERTY = 'tx';

/** The one effect class this rule is the obligation checker for. */
const EPHEMERAL = 'ephemeral';

const SHARED_CONTRACT_MAP = 'packages/shared/src/admin/ops.ts';
const CONTRACT_MAP_NAME = 'ADMIN_OP_CONTRACTS';

interface OpContractFacts {
  readonly name: string;
  readonly effectClass: string;
}

/** One shared-map entry: what it declares, and where a reader would find it. */
interface ContractMapEntry {
  readonly facts: OpContractFacts;
  readonly node: Node;
}

type ContractMap = ReadonlyMap<string, ContractMapEntry>;

/** Where a rule abort points, in the message form the layer already uses. */
function where(node: Node): string {
  return `${relativePath(node.getSourceFile())}:${String(node.getStartLineNumber())}`;
}

function violation(node: Node, message: string): ArchViolation {
  return {
    file: node.getSourceFile().getFilePath(),
    line: node.getStartLineNumber(),
    message,
  };
}

/** One string-literal property of a contract literal, or an abort. */
function literalProperty(
  literal: ObjectLiteralExpression,
  key: string,
  describedAs: string
): string {
  const property = literal.getProperty(key);
  const initializer = Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
  if (!Node.isStringLiteral(initializer)) {
    fail(`cannot read a literal ${key} off ${describedAs}`);
  }
  return initializer.getLiteralValue();
}

/** The `effectClass` and `name` string literals of a `defineAdminOpContract` call. */
function contractFactsFrom(call: CallExpression, describedAs: string): OpContractFacts {
  const [argument] = call.getArguments();
  if (!Node.isObjectLiteralExpression(argument)) {
    fail(`cannot read the contract literal of ${describedAs}`);
  }
  return {
    name: literalProperty(argument, 'name', describedAs),
    effectClass: literalProperty(argument, 'effectClass', describedAs),
  };
}

function isContractDefinition(node: Node | undefined): node is CallExpression {
  return Node.isCallExpression(node) && node.getExpression().getText() === 'defineAdminOpContract';
}

/** One map property read as its key and the contract facts it holds. */
function mapEntryOf(property: Node): readonly [string, ContractMapEntry] {
  if (!Node.isPropertyAssignment(property)) {
    fail(`${CONTRACT_MAP_NAME} holds an entry that is not a plain property`);
  }
  const nameNode = property.getNameNode();
  const key = Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : nameNode.getText();
  const value = property.getInitializer();
  if (!isContractDefinition(value)) {
    fail(`${CONTRACT_MAP_NAME} entry '${key}' is not a defineAdminOpContract call`);
  }
  return [
    key,
    { facts: contractFactsFrom(value, `${CONTRACT_MAP_NAME} entry '${key}'`), node: property },
  ];
}

/**
 * The shared map read as name → facts, each paired with the node it is declared
 * at so an unbound entry is reported where a reader would look for it.
 */
function readSharedContractMap(file: SourceFile | undefined): ContractMap {
  const entries = new Map<string, ContractMapEntry>();
  if (file === undefined) return entries;
  const declaration = file.getVariableDeclaration(CONTRACT_MAP_NAME);
  if (declaration === undefined) {
    fail(`${SHARED_CONTRACT_MAP} declares no ${CONTRACT_MAP_NAME}`);
  }
  const initializer = declaration.getInitializer();
  const literal = Node.isAsExpression(initializer) ? initializer.getExpression() : initializer;
  if (!Node.isObjectLiteralExpression(literal)) {
    fail(`${CONTRACT_MAP_NAME} is not an object literal`);
  }
  for (const property of literal.getProperties()) {
    const [key, entry] = mapEntryOf(property);
    entries.set(key, entry);
  }
  return entries;
}

/** Resolves a `defineAdminOp` contract argument to the contract it names. */
function contractOf(registration: CallExpression, sharedMap: ContractMap): OpContractFacts {
  const [argument] = registration.getArguments();
  const at = where(registration);
  if (!Node.isIdentifier(argument)) {
    fail(`cannot resolve the contract argument of the op registration at ${at}`);
  }
  const declaration = registration.getSourceFile().getVariableDeclaration(argument.getText());
  const initializer = declaration?.getInitializer();
  if (isContractDefinition(initializer)) {
    return contractFactsFrom(initializer, `the contract '${argument.getText()}'`);
  }
  if (
    Node.isElementAccessExpression(initializer) &&
    initializer.getExpression().getText() === CONTRACT_MAP_NAME
  ) {
    const key = initializer.getArgumentExpression();
    if (!Node.isStringLiteral(key)) {
      fail(`cannot resolve the ${CONTRACT_MAP_NAME} key read at ${at}`);
    }
    const entry = sharedMap.get(key.getLiteralValue());
    if (entry === undefined) {
      fail(`${CONTRACT_MAP_NAME} declares no op '${key.getLiteralValue()}' (read at ${at})`);
    }
    return entry.facts;
  }
  fail(`cannot resolve the contract argument of the op registration at ${at}`);
}

/** The `execute` function of a `defineAdminOp` body literal, method or property alike. */
type ExecuteFunction = ArrowFunction | FunctionExpression | MethodDeclaration;

function executeOf(registration: CallExpression): ExecuteFunction {
  const at = where(registration);
  const body = registration.getArguments()[1];
  if (!Node.isObjectLiteralExpression(body)) {
    fail(`cannot read the op body literal of the registration at ${at}`);
  }
  const property = body.getProperty('execute');
  if (Node.isMethodDeclaration(property)) return property;
  const initializer = Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
  if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
    return initializer;
  }
  fail(`cannot read the execute of the op registration at ${at}`);
}

/** What an escaping reference to the context parameter is called in the report. */
function escapeMessage(opName: string, reference: Identifier): string {
  const parent = reference.getParent();
  if (Node.isPropertyAccessExpression(parent) && parent.getName() === TRANSACTION_PROPERTY) {
    return (
      `admin op ${opName} is ephemeral-class but its body takes the settlement transaction ` +
      `handle (${parent.getText()}) — an ephemeral op makes no call taking that handle`
    );
  }
  if (Node.isCallExpression(parent) || Node.isNewExpression(parent)) {
    return (
      `admin op ${opName} is ephemeral-class but hands its context to a call, which can pass ` +
      'the settlement transaction handle out of sight'
    );
  }
  return (
    `admin op ${opName} is ephemeral-class but lets its context escape, so nothing here shows ` +
    'the settlement transaction handle stays unused'
  );
}

function checkExecuteBody(
  opName: string,
  execute: ExecuteFunction,
  violations: ArchViolation[]
): void {
  const [parameter] = execute.getParameters();
  if (parameter === undefined) return;
  const nameNode = parameter.getNameNode();
  if (!Node.isIdentifier(nameNode)) {
    violations.push(
      violation(
        nameNode,
        `admin op ${opName} is ephemeral-class but destructures its context parameter — name it, ` +
          'so the obligation that it never takes the settlement transaction handle stays readable'
      )
    );
    return;
  }
  const contextName = nameNode.getText();
  execute.forEachDescendant((node) => {
    if (!Node.isIdentifier(node) || node === nameNode || node.getText() !== contextName) return;
    const parent = node.getParent();
    // A property or key that merely SPELLS the context's name (`input.ctx`,
    // `{ ctx: value }`) names something else entirely; only the referencing
    // position is a use of the parameter.
    if (
      (Node.isPropertyAccessExpression(parent) || Node.isPropertyAssignment(parent)) &&
      parent.getNameNode() === node
    ) {
      return;
    }
    const readsAnotherProperty =
      Node.isPropertyAccessExpression(parent) &&
      parent.getExpression() === node &&
      parent.getName() !== TRANSACTION_PROPERTY;
    if (readsAnotherProperty) return;
    violations.push(violation(node, escapeMessage(opName, node)));
  });
}

/**
 * The two registration forms, and why only one is read further. A mutation's
 * context carries the settlement transaction handle, so the obligation is a
 * property of what its body does with it and this rule reads the body. A read's
 * context declares no such property at all
 * (`AdminOpReadContext` in `apps/api/src/slices/admin/domain/registry.ts`), so
 * the obligation is discharged by the type: there is nothing for a read body to
 * take, whatever it does. Binding the name is still what the read registration
 * owes, because an ephemeral contract nothing binds is what the unbound check
 * below reports.
 */
const MUTATION_REGISTRATION = 'defineAdminOp';
const READ_REGISTRATION = 'defineAdminReadOp';

/** Checks one file's op registrations, recording every op name it binds. */
function checkRegistrations(
  file: SourceFile,
  sharedMap: ContractMap,
  bound: Set<string>,
  violations: ArchViolation[]
): void {
  for (const node of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = node.getExpression().getText();
    if (callee === READ_REGISTRATION) {
      bound.add(contractOf(node, sharedMap).name);
      continue;
    }
    if (callee !== MUTATION_REGISTRATION) continue;
    const contract = contractOf(node, sharedMap);
    bound.add(contract.name);
    if (contract.effectClass !== EPHEMERAL) continue;
    checkExecuteBody(contract.name, executeOf(node), violations);
  }
}

const rule: ArchRule = {
  name: RULE,
  check(project) {
    const violations: ArchViolation[] = [];
    const sharedMap = readSharedContractMap(sourceFileAt(project, SHARED_CONTRACT_MAP));
    const bound = new Set<string>();
    for (const file of project.getSourceFiles()) {
      if (isTestFile(file.getFilePath())) continue;
      checkRegistrations(file, sharedMap, bound, violations);
    }
    for (const entry of sharedMap.values()) {
      const { name, effectClass } = entry.facts;
      if (effectClass !== EPHEMERAL || bound.has(name)) continue;
      violations.push(
        violation(
          entry.node,
          `admin op ${name} is declared ephemeral-class but the scanned tree binds it to no op ` +
            'body, so its no-settlement-transaction obligation is unchecked'
        )
      );
    }
    return violations;
  },
};

export default rule;
