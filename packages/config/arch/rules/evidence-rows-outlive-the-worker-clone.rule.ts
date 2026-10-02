import { Node, SyntaxKind } from 'ts-morph';
import { REGISTRY_MODULE, REGISTRY_OBJECT, registryMembers } from '../lib/evidence-registry.js';
import { isTestFile, relativePath } from '../lib/paths.js';
import type { CallExpression, Project, SourceFile, VariableDeclaration } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A `service_evidence` row a CI step requires has to outlive the vitest worker
 * that wrote it.
 *
 * Every worker retargets `DATABASE_URL` at a per-worker clone and teardown
 * drops it, while `verify:evidence` opens the base database in a later
 * process. So a row written through an ordinary slot-targeted handle is gone
 * before anything looks for it, and the step that requires the name fails
 * exactly as it fails when the test never ran. Not hypothetical: every
 * credentialed suite here wrote its row that way until the handles were
 * repaired, and nothing went red for it, because the suite that wrote the row
 * passed.
 *
 * WHY A RULE. The repair is one handle per write site, and nothing about a
 * wrong handle is visible at runtime: the write succeeds, the suite passes,
 * and the loss surfaces only in a CI job that fails somewhere else. The next
 * credentialed suite re-creates it by doing the ordinary thing. The handle is
 * statically visible, so this puts the property on the refused-at-the-gate rung
 * of `docs/CODE-RULES.md` §Unattended by Construction rather than leaving it a
 * one-time repair.
 *
 * SCOPE IS THE TEST-FILE SPELLING, not a path list. A production adapter
 * legitimately writes evidence from the handle its caller passes — that is the
 * whole point of `recordServiceEvidence` taking a handle — and it runs in a
 * process no clone was ever made for. Only a file that exists so tests can run
 * can hand it the wrong one.
 *
 * WHICH WRITES ARE IN SCOPE: the ones whose service argument resolves here to a
 * name the registry module declares. The names are read from that module at
 * check time, so this rule holds no second copy of them and follows a rename
 * with no edit. What resolves is a member read off the registry object — by
 * property or by element access, under its own spelling or under a local import
 * alias — a name destructured off it, either of those one binding deep, and a
 * declared name written out as a string.
 *
 * WHAT THAT LEAVES UNGUARDED, which is a limit and not an impossibility: a
 * write whose service argument this rule cannot resolve is PASSED OVER, and a
 * genuinely declared name can reach a call that way. Every boundary this
 * resolution draws is such a route. A constant another module exports —
 * `export const EVIDENCE_SERVICE = SERVICE_NAMES.PUSH_FCM`, imported and
 * passed — escapes the single-file reading, and cross-file constant tracking is
 * a materially larger machine than this rule carries; a name handed on through
 * a second local name escapes the one-hop trace; a name bound below the write
 * that uses it escapes the source-order one. One boundary is drawn before
 * that resolution: this reads calls spelled `recordServiceEvidence`, so a
 * write reaching that function under another spelling — an import alias, a
 * local name assigned from it — is never examined at all. So the guarantee is
 * narrower than "no test writes a required row from the wrong handle": no test
 * file does so in the spellings above. A write that escapes by naming its
 * service somewhere this cannot read still writes the row, and the row is
 * still lost with the clone.
 *
 * That same pass-over is what excludes the registry's own integration suite,
 * which assembles a run-unique name per row: those rows are private to the run
 * and deliberately stay on the clone, where a shared table would give
 * concurrent runs a collision instead. The exclusion is a property of the call
 * rather than of the file holding it — the same file is refused the moment one
 * of its writes names a declared service — which is why there is no path list
 * here.
 *
 * BOTH TRACES READ A NAME THE SAME WAY — lexically, in source order, one
 * binding deep: a name carries whatever its nearest preceding declaration or
 * assignment gave it. So a handle the accessor built and something later
 * reassigned to the worker clone is refused at every write below the
 * reassignment, and a service name an earlier sibling block happened to bind
 * under the same spelling never stands in for the one the write actually names.
 * One resolver serves both readings, because two strategies for the same shape
 * is a rule nobody can reason about — and the divergence failed in both
 * directions at once: a declared name hidden behind an earlier binding passed
 * silently, which is the silence this rule exists to delete, while a run-private
 * name behind an earlier declared one was accused of something it did not do.
 *
 * WHAT THE TWO TRACES DO WITH A FAILURE DIFFERS, and the harm is why. A service
 * argument the trace cannot resolve is passed over, since this rule is only
 * about names a requirement can demand. A handle it cannot trace — one arriving
 * as a parameter, off an imported factory, destructured out of a helper, or
 * bound below the write that uses it — is REFUSED rather than passed:
 * fail-closed is the choice the harm forces, because passing it is that same
 * silence, and a correct handle is always one line from being named where the
 * rule can see it.
 *
 * WHAT IT DOES NOT CATCH: a test handing a clone-targeted handle to a
 * production adapter with its evidence gate forced open. The write site is then
 * in the adapter, outside this scope. Widening the scope to the handoff would
 * refuse the tests that deliberately do exactly that — the throwing stub handle
 * passed with `isCI: true` in
 * `apps/api/src/slices/media/domain/gc.integration.test.ts` and in
 * `apps/api/src/slices/media/adapters/storage-r2.integration.test.ts`, each
 * proving its adapter maps an evidence-write failure to `unavailable`.
 */

const RULE_NAME = 'evidence-rows-outlive-the-worker-clone';

/** The one function that writes an evidence row. */
const EVIDENCE_WRITE = 'recordServiceEvidence';

/** The accessor yielding the database a worker clone was made from. */
const DURABLE_ACCESSOR = 'evidenceDatabaseUrl';

const MISSING_REGISTRY_REMEDY =
  'The service names are read from that module so this rule holds no second copy of them; with ' +
  'it gone there is nothing to resolve a write against, and every write below would read as ' +
  'naming no declared service — which this rule passes over. Point it at the registry module in ' +
  'the change that moved it.';

const EMPTY_REGISTRY_MESSAGE =
  `${REGISTRY_MODULE} declares no \`${REGISTRY_OBJECT}\` members this rule can read. ` +
  'This is a LIVENESS failure of the rule, not a finding about a write site: with no names ' +
  'resolved, every evidence write reads as naming no declared service and the rule reports ' +
  'success over an invariant it has stopped enforcing. If the registry was renamed or changed ' +
  'shape, give this rule the new spelling in the same change.';

/** The callee's own name, however the call is qualified. */
function calleeName(call: CallExpression): string {
  const expression = call.getExpression();
  return Node.isPropertyAccessExpression(expression) ? expression.getName() : expression.getText();
}

/** The declared services, in the two readings a write argument needs. */
interface ServiceRegistry {
  /** Value by the member spelling a call site reads it off. */
  byMember: Map<string, string>;
  /** Every declared name, for a call site that writes the string itself. */
  declared: Set<string>;
}

/**
 * The declared services, over the shared read of the registry module.
 *
 * A member carrying no inline name is dropped, since a name this rule cannot
 * resolve is one no requirement can demand — and the shared walk aborts when
 * the drop leaves nothing, which is the rule's own subject going missing rather
 * than a finding: a rule that resolves no name passes every write site there
 * is.
 */
function declaredServices(project: Project): ServiceRegistry {
  const named = registryMembers(
    RULE_NAME,
    project,
    { missingModule: MISSING_REGISTRY_REMEDY, emptyRegistry: EMPTY_REGISTRY_MESSAGE },
    (member) => (member.name === undefined ? undefined : ([member.written, member.name] as const))
  );
  return {
    byMember: new Map(named),
    declared: new Set(named.map(([, value]) => value)),
  };
}

/** An expression with its type assertions stripped. */
function unwrapped(node: Node): Node {
  return Node.isAsExpression(node) ? unwrapped(node.getExpression()) : node;
}

/** The leftmost identifier of a reference expression (`a.b` → `a`). */
function rootName(node: Node): string | undefined {
  const value = unwrapped(node);
  if (Node.isIdentifier(value)) return value.getText();
  if (Node.isPropertyAccessExpression(value)) return rootName(value.getExpression());
  return undefined;
}

/** Local spellings of the registry object in one file: its own name, plus every import alias. */
function localRegistryNames(file: SourceFile): Set<string> {
  const aliases = file
    .getImportDeclarations()
    .flatMap((declaration) => declaration.getNamedImports())
    .filter((specifier) => specifier.getName() === REGISTRY_OBJECT)
    .map((specifier) => specifier.getAliasNode())
    .filter((alias) => alias !== undefined)
    .map((alias) => alias.getText());
  return new Set([REGISTRY_OBJECT, ...aliases]);
}

/** The node names the registry object, under its own spelling or a local alias. */
function isRegistryReference(node: Node, names: Set<string>): boolean {
  return Node.isIdentifier(node) && names.has(node.getText());
}

/** The member spelling a `SERVICE_NAMES.LINEAR` or `SERVICE_NAMES['LINEAR']` read names. */
function registryMemberRead(value: Node, names: Set<string>): string | undefined {
  if (Node.isPropertyAccessExpression(value) && isRegistryReference(value.getExpression(), names)) {
    return value.getName();
  }
  if (!Node.isElementAccessExpression(value) || !isRegistryReference(value.getExpression(), names))
    return undefined;
  const argument = value.getArgumentExpression();
  return argument !== undefined && Node.isStringLiteral(argument)
    ? argument.getLiteralValue()
    : undefined;
}

/** The declaration takes its whole value from the registry object. */
function isRegistryInitialized(declaration: VariableDeclaration, names: Set<string>): boolean {
  const initializer = declaration.getInitializer();
  return initializer !== undefined && isRegistryReference(unwrapped(initializer), names);
}

/**
 * `const { LINEAR } = SERVICE_NAMES` — every member this file destructures off
 * the registry, from the local name back to the member spelling it came from.
 */
function destructuredMembers(file: SourceFile, names: Set<string>): Map<string, string> {
  const entries = file
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .filter((declaration) => isRegistryInitialized(declaration, names))
    .flatMap((declaration) => declaration.getDescendantsOfKind(SyntaxKind.BindingElement))
    .map(
      (element) =>
        [element.getName(), element.getPropertyNameNode()?.getText() ?? element.getName()] as const
    );
  return new Map(entries);
}

/** One point where this file gives a name a value. */
interface Binding {
  position: number;
  value: Node;
}

/** Everything one file's rules need to read, resolved once per file. */
interface FileContext {
  filePath: string;
  registry: ServiceRegistry;
  /** Spellings that name the registry object here. */
  registryNames: Set<string>;
  /** Local name → the registry member it was destructured off. */
  destructured: Map<string, string>;
  /** Name → every value it is given, in source order. */
  bindings: Map<string, Binding[]>;
}

/**
 * The value this file last gave a name before a given position.
 *
 * Both of this rule's traces read a name through this one resolver, so the
 * service a write names and the handle it writes from resolve by the same
 * reading — see {@link declaredServiceWritten} and {@link isDurableHandle}. It
 * has to be the nearest preceding binding rather than the file's first: `const
 * service` and `const testService` are reused across sibling `it` blocks in
 * ordinary test writing, and reading the first would let an earlier block's
 * unresolvable name hide a later block's declared one — a silent pass — while
 * the reverse order would accuse a run-private write of naming a declared
 * service.
 */
function boundValue(bindings: Map<string, Binding[]>, name: string, at: number): Node | undefined {
  const given = (bindings.get(name) ?? []).filter((binding) => binding.position < at);
  return given.at(-1)?.value;
}

/**
 * The DECLARED service a write argument names, or nothing — which is the
 * in-scope test: a name assembled at run time, one reaching the call from
 * another module, and one no longer declared all resolve to nothing, and this
 * rule passes over the write rather than guessing at it.
 */
function declaredServiceWritten(
  argument: Node,
  context: FileContext,
  at: number,
  followBinding: boolean
): string | undefined {
  const value = unwrapped(argument);
  if (Node.isStringLiteral(value)) {
    const literal = value.getLiteralValue();
    return context.registry.declared.has(literal) ? literal : undefined;
  }
  const read = registryMemberRead(value, context.registryNames);
  if (read !== undefined) return context.registry.byMember.get(read);
  if (!Node.isIdentifier(value)) return undefined;
  const destructured = context.destructured.get(value.getText());
  if (destructured !== undefined) return context.registry.byMember.get(destructured);
  if (!followBinding) return undefined;
  const bound = boundValue(context.bindings, value.getText(), at);
  return bound === undefined ? undefined : declaredServiceWritten(bound, context, at, false);
}

/** The node is, or lexically contains, a call of the durable accessor. */
function callsAccessor(node: Node): boolean {
  if (Node.isCallExpression(node) && calleeName(node) === DURABLE_ACCESSOR) return true;
  return node
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some((call) => calleeName(call) === DURABLE_ACCESSOR);
}

/** A declaration that gives a name its value. */
function declarationBindings(file: SourceFile): [string, Binding][] {
  return file.getDescendantsOfKind(SyntaxKind.VariableDeclaration).flatMap((declaration) => {
    const initializer = declaration.getInitializer();
    if (initializer === undefined) return [];
    const binding = { position: declaration.getStart(), value: initializer };
    return [[declaration.getName(), binding] satisfies [string, Binding]];
  });
}

/** An assignment that gives a name a new value. */
function assignmentBindings(file: SourceFile): [string, Binding][] {
  return file
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .filter((assignment) => assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken)
    .flatMap((assignment) => {
      const name = rootName(assignment.getLeft());
      if (name === undefined) return [];
      const binding = { position: assignment.getStart(), value: assignment.getRight() };
      return [[name, binding] satisfies [string, Binding]];
    });
}

/**
 * Every value this file gives a name, per name, in source order.
 *
 * Source order is what makes the reading assignment-sensitive, which the
 * durability question needs: a name is only as durable as its nearest preceding
 * binding, so a handle the accessor built and something later pointed at the
 * worker clone stops being durable at that reassignment instead of staying
 * durable for the rest of the file. The service a write names is read the same
 * way, off the same map.
 */
function nameBindings(file: SourceFile): Map<string, Binding[]> {
  const bindings = new Map<string, Binding[]>();
  for (const [name, binding] of [...declarationBindings(file), ...assignmentBindings(file)]) {
    bindings.set(name, [...(bindings.get(name) ?? []), binding]);
  }
  for (const given of bindings.values())
    given.sort((left, right) => left.position - right.position);
  return bindings;
}

/** The handle is the durable one where it is used: built inline from the accessor, or last bound to it. */
function isDurableHandle(handle: Node, context: FileContext, at: number): boolean {
  if (callsAccessor(handle)) return true;
  const root = rootName(handle);
  if (root === undefined) return false;
  const bound = boundValue(context.bindings, root, at);
  return bound !== undefined && callsAccessor(bound);
}

function evidenceWrites(file: SourceFile): CallExpression[] {
  return file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => calleeName(call) === EVIDENCE_WRITE);
}

function violationMessage(handle: string, filePath: string, service: string): string {
  return (
    `\`${handle}\` in ${filePath} does not resolve here to the evidence-durable database handle, ` +
    `and the row it would write carries \`${service}\` — a name \`verify:evidence --require\` can ` +
    'demand. The verifier opens the base database in a later process, after teardown has dropped ' +
    'the worker clone, so a row written through an ordinary slot-targeted handle is unreachable ' +
    'by the step that requires it and fails exactly as a test that never ran would. Build the ' +
    'handle from ' +
    `\`${DURABLE_ACCESSOR}(process.env)\` (\`@hushbox/db/test-db\`), which yields the database the ` +
    'clone was made from.'
  );
}

/** One write site's verdict: a violation, or nothing when it is out of scope or correct. */
function writeViolation(write: CallExpression, context: FileContext): ArchViolation | undefined {
  const [handle, , service] = write.getArguments();
  if (handle === undefined || service === undefined) return undefined;

  const at = write.getStart();
  const written = declaredServiceWritten(service, context, at, true);
  if (written === undefined) return undefined;
  if (isDurableHandle(handle, context, at)) return undefined;

  return {
    file: context.filePath,
    line: write.getStartLineNumber(),
    message: violationMessage(handle.getText(), context.filePath, written),
  };
}

/** Every offending write in one file; a file outside the test spelling has none. */
function fileViolations(file: SourceFile, registry: ServiceRegistry): ArchViolation[] {
  const filePath = relativePath(file);
  if (!isTestFile(filePath)) return [];

  const registryNames = localRegistryNames(file);
  const context: FileContext = {
    filePath,
    registry,
    registryNames,
    destructured: destructuredMembers(file, registryNames),
    bindings: nameBindings(file),
  };
  return evidenceWrites(file)
    .map((write) => writeViolation(write, context))
    .filter((violation) => violation !== undefined);
}

const rule: ArchRule = {
  name: RULE_NAME,
  check(project) {
    const registry = declaredServices(project);
    return project.getSourceFiles().flatMap((file) => fileViolations(file, registry));
  },
};

export default rule;
