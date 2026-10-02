import { Node, SyntaxKind } from 'ts-morph';
import { failWith, isTestFile, relativePath } from '../lib/paths.js';
import type {
  ArrowFunction,
  CallExpression,
  FunctionExpression,
  Project,
  SourceFile,
  Symbol as TypeSymbol,
  Type,
  TypeNode,
  VariableDeclaration,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Cron hosts only pollers, retention deletes, and read-only auditors — never
 * delivery (CODE-RULES §Jobs & Async). Delivery is must-happen work, and the
 * only mechanism that makes it must-happen is a `jobs` row: a cron tick that
 * sends has no lease, no failure budget, no idempotency class and no dead
 * letter, so a send that fails on one tick is simply lost until some later tick
 * decides to try again. Cron's part is to ENQUEUE; the dispatcher delivers.
 *
 * TWO ARMS, because delivery reaches cron by two different doors.
 *
 * 1. A cron entry that calls a delivery port's send method. The subject is
 *    every named function whose signature RESOLVES to a `CronEntry`, read in
 *    both spellings a function is written in — a function declaration, and a
 *    binding initialized with an arrow function or a function expression.
 *    Reading declarations alone would let one ordinary stylistic edit carry an
 *    entry out of the subject set, and no empty-set abort can see a subject
 *    that left a non-empty set. The type checker answers the question, so WHICH
 *    declaration carries the written type decides nothing: annotated on the
 *    function or carried by the binding that holds it, one resolved signature
 *    comes back. That is what makes the shared ESLint config's
 *    `allowTypedFunctionExpressions` release immaterial here — reading the
 *    annotation instead, a binding that types itself declares no return type at
 *    all and leaves the subject set on one keystroke, which is the escape this
 *    premise exists to close. The methods are read off the delivery ports
 *    themselves rather than written down here, so a port that grows a second
 *    send verb is covered the day it does.
 *
 * 2. A cron entry composition that builds a live delivery port. The digest is
 *    the shape this protects: cron holds an email sender, and holds it only as
 *    the argument of `enqueueOnlyDeps`, the marker that says the value is
 *    handed to a registration the enqueue path never invokes. The same
 *    construction outside that marker is a sender cron can actually send with,
 *    which is the previous arm one refactor away.
 *
 * WHAT A DELIVERY PORT IS, derived rather than listed: an interface declared in
 * a slice's `ports/` directory whose name ends in `Sender` or `EmailPort`. That
 * is a naming convention and it is stated as one — a delivery port named
 * outside it would be invisible here. A function is matched to one by SYMBOL
 * rather than by the text its return type renders as, so an import alias, a
 * re-export through a barrel and the checker's fully-qualified spelling all
 * name the same port. What keeps the convention from decaying silently is that
 * an empty derivation ABORTS: every set this rule derives fails the check when
 * it comes back empty, because a rule that matched nothing and a rule that was
 * disarmed are otherwise the same green. The one departure emptiness cannot
 * show is a port the checker fails to resolve — it carries no symbol, so its
 * producer leaves a set that stays populated — so a written port name whose
 * type resolves to `any` aborts as well: the source still spells the name the
 * resolved type lost.
 *
 * WHAT IT DOES NOT SEE. Representative rather than exhaustive:
 * - Delivery reached through a function in ANOTHER module. Arm 1 closes over
 *   calls within the entry's own file, so a cron entry calling a helper that
 *   sends breaks the chain at the import. The shape refused is delivery written
 *   into the cron surface, not every path that can eventually reach a port.
 * - A delivery capability that is a function type rather than a port interface
 *   (`NotifyConversationEvent`), which is invoked by name and names no method.
 * - A port reached through a computed member (`sender[verb](message)`).
 * - A signature that writes its return type NOWHERE and infers one built in
 *   place. The inferred type of a returned object literal renders structurally
 *   and carries that literal's own symbol, so it spells neither the entry name
 *   arm 1 reads nor the port symbol arm 2 matches, and its function leaves the
 *   set. A WRITTEN type is what carries a name through; where one exists, which
 *   declaration holds it decides nothing.
 *
 * WHAT PINS THE PREDICATES HERE. A sweep that deletes each operand of a `&&`
 * or `||` in turn and watches for a red is the right instrument — branch
 * coverage reads full over an arm nothing exercises — but two shapes below
 * survive that deletion without being unpinned, and converting either into a
 * fixture would buy the appearance of a pin and no claim.
 * - The `Node.isIdentifier(callee)` guards decide nothing on their own. Each
 *   sits upstream of a reading of that callee's TEXT, and every such reading
 *   compares the text against an identifier — a declared function's name, the
 *   enqueue-only marker, a derived set of factory names. A callee spelled any
 *   other way yields text that cannot be a declared name — punctuation in the
 *   composite spellings (`deps.sender.send`, `mail!`), a reserved word in the
 *   bare ones — which no such comparison matches, so deleting a guard changes
 *   no answer the rule reaches. They narrow a type for the reader; a fixture
 *   written to cover one would have to assert something this rule does not
 *   decide.
 * - The operands rejecting an `undefined` before the value reaches a call or
 *   a typed collection are pinned by the type checker instead of the suite:
 *   delete one and every test still passes while the package typecheck
 *   refuses the site that value feeds. A compiler gate is still a gate — it
 *   is simply not the one a test run reports, so a sweep reading only reds
 *   will score those operands as unpinned.
 */

const RULE = 'cron-hosts-no-delivery';
const fail = failWith(RULE);

/** The tree the cron surface lives in. */
const API_SOURCE_TREE = 'apps/api/src/';

/** A slice's published infra edges; the delivery ports are the ones named below. */
const PORTS_DIRECTORY = /\/slices\/[^/]+\/ports\//;

/** The naming convention that says an interface in `ports/` is a delivery port. */
const DELIVERY_PORT_NAME = /(?:Sender|EmailPort)$/;

/** The type a cron entry's signature produces. */
const CRON_ENTRY_TYPE = 'CronEntry';

/** The type an `async` signature wraps whatever it produces in. */
const PROMISE_TYPE = 'Promise';

/**
 * The marker that says a value is handed to a registration the enqueue path
 * reads metadata off and never invokes — so a delivery port inside it is a
 * dependency of the dispatcher's handler, not of the cron tick.
 */
const ENQUEUE_ONLY_MARKER = 'enqueueOnlyDeps';

function isInScope(filePath: string): boolean {
  return filePath.includes(API_SOURCE_TREE) && !isTestFile(filePath);
}

function scannedFiles(project: Project): SourceFile[] {
  return project.getSourceFiles().filter((file) => isInScope(relativePath(file)));
}

/** The delivery ports one `ports/` module declares, each with the methods it publishes. */
function deliveryPortsIn(
  file: SourceFile
): { name: string; symbol: TypeSymbol; methods: string[] }[] {
  if (!PORTS_DIRECTORY.test(`/${relativePath(file)}`)) return [];
  return file
    .getInterfaces()
    .filter((declaration) => DELIVERY_PORT_NAME.test(declaration.getName()))
    .map((declaration) => ({
      name: declaration.getName(),
      symbol: declaration.getSymbolOrThrow(),
      methods: declaration.getMethods().map((method) => method.getName()),
    }));
}

/** The delivery ports themselves — by symbol, by written name — and every method they publish. */
function deliverySurface(files: readonly SourceFile[]): {
  portSymbols: Set<TypeSymbol>;
  portNames: Set<string>;
  methods: Set<string>;
} {
  const ports = files.flatMap((file) => deliveryPortsIn(file));
  return {
    portSymbols: new Set(ports.map((port) => port.symbol)),
    portNames: new Set(ports.map((port) => port.name)),
    methods: new Set(ports.flatMap((port) => port.methods)),
  };
}

interface DeclaredFunction {
  name: string | undefined;
  /** What the signature produces, resolved rather than read off an annotation. */
  produces: Type;
  /** What {@link DeclaredFunction.produces} renders against, so its text reads as its own module writes it. */
  declaration: Node;
  /** The return type as the SOURCE writes it, which survives a type the checker cannot resolve. */
  written: TypeNode | undefined;
  body: Node | undefined;
}

/**
 * What a binding's function produces. The BINDING's type answers first, so a
 * binding that types itself and leaves its function unannotated reads exactly
 * like one that annotates it; the function answers only where the binding's
 * type declares no call signature to read.
 */
function producedBy(
  binding: VariableDeclaration,
  initializer: ArrowFunction | FunctionExpression
): Type {
  const [signature] = binding.getType().getCallSignatures();
  return signature === undefined ? initializer.getReturnType() : signature.getReturnType();
}

/**
 * Every function this module declares under a name, in both spellings one is
 * written in. Both derivations below read this rather than `getFunctions()`
 * alone, because rewriting a function declaration as an arrow const is an
 * ordinary stylistic edit and would otherwise remove its subject from the set
 * with nothing left empty for an abort to notice.
 */
function declaredFunctions(file: SourceFile): DeclaredFunction[] {
  const declarations: DeclaredFunction[] = file.getFunctions().map((declaration) => ({
    name: declaration.getName(),
    produces: declaration.getReturnType(),
    declaration,
    written: declaration.getReturnTypeNode(),
    body: declaration.getBody(),
  }));
  const bindings: DeclaredFunction[] = file.getVariableDeclarations().flatMap((binding) => {
    const initializer = binding.getInitializer();
    if (initializer === undefined) return [];
    if (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer)) return [];
    return [
      {
        name: binding.getName(),
        produces: producedBy(binding, initializer),
        declaration: binding,
        written: binding.getTypeNode() ?? initializer.getReturnTypeNode(),
        body: initializer.getBody(),
      },
    ];
  });
  return [...declarations, ...bindings];
}

/** What a caller ends up holding, past an `async` signature's promise. */
function producedTypes(produces: Type): readonly Type[] {
  return produces.getSymbol()?.getName() === PROMISE_TYPE
    ? produces.getTypeArguments()
    : [produces];
}

/** True when the type IS one of the delivery ports, whatever it renders as. */
function isDeliveryPort(type: Type, ports: ReadonlySet<TypeSymbol>): boolean {
  const symbol = type.getSymbol();
  return symbol !== undefined && ports.has(symbol);
}

/**
 * True when the SOURCE writes the name of a port this scan declares into this
 * return type. Read off the written text rather than the resolved type, because
 * the case it exists for is the resolved type having lost that name.
 */
function namesDeliveryPort(written: TypeNode, portNames: ReadonlySet<string>): boolean {
  return written
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .some((identifier) => portNames.has(identifier.getText()));
}

/**
 * Every function in ONE module that builds a delivery port, by what its
 * signature produces — and the abort for the one way a member leaves this set
 * without emptying it: a written port name the checker resolved to `any`.
 */
function deliveryFactoriesIn(
  file: SourceFile,
  ports: ReadonlySet<TypeSymbol>,
  portNames: ReadonlySet<string>
): string[] {
  const names: string[] = [];
  for (const { name, produces, written } of declaredFunctions(file)) {
    if (name === undefined) continue;
    const produced = producedTypes(produces);
    if (
      written !== undefined &&
      namesDeliveryPort(written, portNames) &&
      produced.some((type) => type.isAny())
    ) {
      fail(
        `\`${name}\` in ${relativePath(file)} writes the return type \`${written.getText()}\`, which the checker resolved to \`any\`. ` +
          'A port that does not resolve carries no symbol, so its producer drops out of the set the delivery arm derives while that set stays populated and nothing else notices. ' +
          'Either the module declaring that port left the scanned project, or the import naming it is broken.'
      );
    }
    if (produced.some((type) => isDeliveryPort(type, ports))) names.push(name);
  }
  return names;
}

/** Every function that builds one of those ports. */
function deliveryFactories(
  files: readonly SourceFile[],
  ports: ReadonlySet<TypeSymbol>,
  portNames: ReadonlySet<string>
): Set<string> {
  return new Set(files.flatMap((file) => deliveryFactoriesIn(file, ports, portNames)));
}

/** Every function whose signature says it produces cron entries. */
function cronEntryFunctions(files: readonly SourceFile[]): { file: SourceFile; body: Node }[] {
  const subjects: { file: SourceFile; body: Node }[] = [];
  for (const file of files) {
    for (const { produces, declaration, body } of declaredFunctions(file)) {
      if (body === undefined) continue;
      if (produces.getText(declaration).includes(CRON_ENTRY_TYPE)) subjects.push({ file, body });
    }
  }
  return subjects;
}

/**
 * The body of a function this module declares under `name`, in either spelling
 * a helper is written in. A name no local function carries — an import, a
 * method, a binding holding something else — has no body to walk into.
 */
function localFunctionBody(file: SourceFile, name: string): Node | undefined {
  const declared = file.getFunction(name);
  if (declared !== undefined) return declared.getBody();
  const initializer = file.getVariableDeclaration(name)?.getInitializer();
  if (initializer === undefined) return undefined;
  return Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)
    ? initializer.getBody()
    : undefined;
}

function walkCalls(
  body: Node,
  file: SourceFile,
  found: CallExpression[],
  entered: Set<string>
): void {
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    found.push(call);
    const callee = call.getExpression();
    if (!Node.isIdentifier(callee) || entered.has(callee.getText())) continue;
    entered.add(callee.getText());
    const local = localFunctionBody(file, callee.getText());
    if (local !== undefined) walkCalls(local, file, found, entered);
  }
}

/**
 * Every call the subject can reach without leaving its own module: its own
 * calls, plus those of each same-file function it names, to a fixpoint.
 */
function moduleLocalCalls(root: Node, file: SourceFile): CallExpression[] {
  const found: CallExpression[] = [];
  walkCalls(root, file, found, new Set());
  return found;
}

/** True when the call sits inside an `enqueueOnlyDeps(...)` argument. */
function isEnqueueOnly(call: CallExpression): boolean {
  return call.getAncestors().some((ancestor) => {
    if (!Node.isCallExpression(ancestor)) return false;
    const callee = ancestor.getExpression();
    return Node.isIdentifier(callee) && callee.getText() === ENQUEUE_ONLY_MARKER;
  });
}

function violationsFor(
  subject: { file: SourceFile; body: Node },
  methods: ReadonlySet<string>,
  factories: ReadonlySet<string>
): ArchViolation[] {
  const file = relativePath(subject.file);
  const violations: ArchViolation[] = [];
  for (const call of moduleLocalCalls(subject.body, subject.file)) {
    const callee = call.getExpression();
    if (Node.isPropertyAccessExpression(callee) && methods.has(callee.getName())) {
      violations.push({
        file,
        line: call.getStartLineNumber(),
        message: `a cron entry calls the delivery port method \`${callee.getName()}\` — cron hosts pollers, retention deletes and read-only auditors, and hands delivery to the jobs system by enqueuing a row the dispatcher runs.`,
      });
      continue;
    }
    if (Node.isIdentifier(callee) && factories.has(callee.getText()) && !isEnqueueOnly(call)) {
      violations.push({
        file,
        line: call.getStartLineNumber(),
        message: `a cron entry builds the delivery port \`${callee.getText()}\` outside \`${ENQUEUE_ONLY_MARKER}\` — a sender cron can send with is delivery on the cron surface; build it as the enqueue-only dependency of the registration the dispatcher runs.`,
      });
    }
  }
  return violations;
}

const rule: ArchRule = {
  name: RULE,
  check(project) {
    const files = scannedFiles(project);
    const { portSymbols, portNames, methods } = deliverySurface(files);
    if (methods.size === 0) {
      fail(
        `found no delivery port under '${API_SOURCE_TREE}', so it is standing over nothing. ` +
          'Either the ports moved, or a delivery port is now named outside the Sender/EmailPort convention this rule reads.'
      );
    }
    const subjects = cronEntryFunctions(files);
    if (subjects.length === 0) {
      fail(
        `found no cron entry under '${API_SOURCE_TREE}', so it is standing over nothing. ` +
          `Either the cron surface moved, or its factories no longer produce a ${CRON_ENTRY_TYPE}.`
      );
    }
    if (files.every((file) => file.getFunction(ENQUEUE_ONLY_MARKER) === undefined)) {
      fail(
        `found no \`${ENQUEUE_ONLY_MARKER}\` declaration, so every enqueue-only dependency would ` +
          'read as live delivery. Either it was renamed, or the enqueue-only seam is gone.'
      );
    }
    const factories = deliveryFactories(files, portSymbols, portNames);
    if (factories.size === 0) {
      fail(
        `found no function producing a delivery port under '${API_SOURCE_TREE}', so the arm ` +
          'watching cron for one built live is standing over nothing. Either the factories moved, ' +
          'or none of them produces a delivery port any more.'
      );
    }
    return subjects.flatMap((subject) => violationsFor(subject, methods, factories));
  },
};

export default rule;
