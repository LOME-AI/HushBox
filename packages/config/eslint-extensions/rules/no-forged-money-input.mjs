/**
 * Refuses the values that reach the E2E money vocabulary without coming from a
 * read, in the three shapes the type system provably cannot refuse.
 *
 * EARLY WARNING, NOT THE GUARANTEE. Every predicate here reads the TYPE of a
 * value, and a type belongs to the position a value sits in — so parking the
 * value one token away (on a property, in a destructure, behind a helper) puts
 * it out of reach, and six successive versions of this rule were each falsified
 * that way. The guarantee is the vocabulary's own runtime refusal: it compares
 * only payloads a read registered, and freezes what it registers. This rule
 * earns its place by reporting before the test runs, not by being what stops a
 * forgery.
 *
 * WHY A LINT RULE AND NOT A TYPE. The vocabulary brands every value it prices
 * from, so a hand-written object and a spread that rewrites one field are both
 * compile errors. What stays legal is structural, not accidental: `any` is
 * assignable to everything; `Object.assign<T, U>` is DECLARED to return `T & U`,
 * and `T & U` is assignable to `T` by construction, at object level and field
 * level alike; and TypeScript ignores `readonly` in assignability, so a branded
 * field is assignable to a plain-typed one and can then be written through.
 *
 * WHAT IT PROTECTS. A forged charge basis makes every derivation from it wrong;
 * a forged money state makes the nothing-moved assertion PASS over numbers
 * nothing read, which is a green test proving nothing — the defect class this
 * whole vocabulary exists to delete.
 *
 * IT ASKS THE TYPE, NOT THE SPELLING. Three predicates, no list of forgers:
 *
 *  1. **An argument the compiler cannot name.** `any` — `JSON.parse`,
 *     `response.json()`, `Object.create`, `Reflect.get`, an untyped import — or
 *     an intersection assembled at the call site, which is what `Object.assign`
 *     returns. An honest argument's type is the declared type a read returns.
 *  2. **A write through a widened alias.** A member assignment on a binding
 *     that was GIVEN a branded value: `const w: { n: bigint } = state` compiles,
 *     and `w.n = …` then rewrites a reading in place. The annotation is the
 *     forgery, so what the binding was given is asked — its initialiser and
 *     every later assignment alike, since declaring the binding harmlessly and
 *     assigning the reading a statement later is the same widening.
 *  3. **A brand laundered through a declaration we do not own.** A call into a
 *     `.d.ts` this codebase did not write that is HANDED a branded value and
 *     RETURNS one — `Object.assign`'s mutating form, `Object.defineProperty`.
 *     The returned brand is what the predicate asks for, so a mutator declared
 *     to return something else is outside it by construction: `Reflect.set`
 *     returns `boolean` and draws no report. Nothing first-party is matched
 *     either, so the vocabulary's own helpers and a spec's own functions are
 *     not caught by it.
 *
 * Naming forgers was tried for five cycles and each list was falsified by the
 * next value nobody had listed. A predicate over the type has no list to be
 * missing an entry from.
 *
 * WHAT IT DOES NOT SEE, stated so the limit is not assumed away. Predicates 2
 * and 3 are evaluated only in a file that also CALLS the vocabulary — a value
 * forged in one file and asserted in another is the cross-boundary laundering
 * this design already leaves open, and the bound is what keeps the type queries
 * off the whole repo. A callee reached other than as its own name, its imported
 * name or a namespace member — a runtime-computed key, a property path — is not
 * resolved. And a cast is deliberately open: it is greppable, which is the
 * point of leaving it unreported rather than chased.
 *
 * A single forgery can draw two reports — one where the value was assembled,
 * one where it was handed in. Both are true, and neither is worth suppressing.
 */
import ts from 'typescript';
import { brandDetection, isFirstParty } from './money-brand.mjs';

/** The static name a specifier, key or member carries, in either spelling. */
/** @typedef {ReturnType<import('eslint').SourceCode['getAncestors']>[number]} AstNode */
/** @typedef {Extract<AstNode, { type: 'CallExpression' }>} CallNode */
/** @typedef {Extract<AstNode, { type: 'MemberExpression' }>} MemberNode */

/** @param {AstNode} node */
function staticName(node) {
  return node.type === 'Identifier'
    ? node.name
    : String(/** @type {{ value?: unknown }} */ (node).value);
}

/**
 * The name a binding was IMPORTED or DESTRUCTURED under, never its local alias.
 * A local name is the author's to choose, so matching one would make the rule
 * evadable by renaming at the import.
 */
/**
 * @param {import('eslint').Scope.Variable | undefined} variable
 * @param {string} localName
 */
function boundName(variable, localName) {
  const node = variable?.defs[0]?.node;
  if (node?.type === 'ImportSpecifier') return staticName(node.imported);
  if (node?.type !== 'VariableDeclarator' || node.id.type !== 'ObjectPattern') return localName;
  const property = /** @type {Extract<AstNode, { type: 'Property' }> | undefined} */ (
    node.id.properties.find(
      /** @param {AstNode} candidate */
      (candidate) =>
        candidate.type === 'Property' &&
        !candidate.computed &&
        candidate.value.type === 'Identifier' &&
        candidate.value.name === localName
    )
  );
  return property === undefined ? localName : staticName(property.key);
}

/** The binding a member-assignment target is ultimately written through. */
/**
 * @param {AstNode | undefined} target
 * @returns {Extract<AstNode, { type: 'Identifier' }> | undefined}
 */
function rootIdentifier(target) {
  let current = target;
  while (current?.type === 'MemberExpression') current = current.object;
  return current?.type === 'Identifier' ? current : undefined;
}

/**
 * The two ways a value's type says the compiler could not name it: `any`, which
 * is assignable to every brand, and an intersection assembled at the call site
 * rather than declared anywhere, which is what `Object.assign` hands back.
 */
/**
 * @param {import('typescript').Type} type
 * @returns {string | undefined}
 */
function unnameable(type) {
  if (type.flags === ts.TypeFlags.Any) return '`any`';
  return type.isIntersection() && type.aliasSymbol === undefined
    ? 'an intersection assembled at the call site'
    : undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Refuse values the type system cannot refuse from reaching the E2E money vocabulary.',
    },
    schema: [
      {
        type: 'object',
        properties: { vocabulary: { type: 'array', items: { type: 'string' } } },
        required: ['vocabulary'],
        additionalProperties: false,
      },
    ],
    messages: {
      unnameable:
        'this argument has the type {{what}}, which the compiler cannot refuse against a brand. ' +
        'A money input comes from a read, and a read returns a declared type: ' +
        'readMockChargeBasis, readServedModelPricing or readMoneyState.',
      writeThrough:
        'this writes through a widened alias of a value that was read — TypeScript ignores ' +
        '`readonly` when the branded value is assigned to a plain-typed binding, so the brand ' +
        'survives while the number is replaced. Read the value again instead of rewriting it.',
      laundered:
        "'{{callee}}' is declared outside this codebase, takes the branded value and returns it " +
        'branded, so it can rewrite a reading in place and nothing downstream can tell. ' +
        'A money input comes from a read.',
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const vocabulary = new Set(context.options[0].vocabulary);
    const sourceCode = context.sourceCode;
    const services = sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) {
      throw new Error(
        'no-forged-money-input is type-aware: configure parserOptions.projectService (or .project).'
      );
    }
    const checker = services.program.getTypeChecker();
    const carriesBrand = brandDetection(checker);
    /** @param {AstNode} node */
    const typeOf = (node) => checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));

    /** Vocabulary calls, and the shapes evaluated only if the file has one. */
    /** @type {CallNode[]} */
    const vocabularyCalls = [];
    /** @type {CallNode[]} */
    const ambientCalls = [];
    /** @type {MemberNode[]} */
    const memberWrites = [];
    /** @type {Extract<AstNode, { type: 'AssignmentExpression' }>[]} */
    const rebindings = [];

    /** Inner scope first, so the nearest binding of a name wins. */
    /** @param {AstNode} node */
    function scopeChain(node) {
      /** @type {import('eslint').Scope.Scope[]} */
      const chain = [];
      for (
        let scope = /** @type {import('eslint').Scope.Scope | null} */ (sourceCode.getScope(node));
        scope !== null;
        scope = scope.upper
      ) {
        chain.push(scope);
      }
      return chain;
    }

    /** @param {Extract<AstNode, { type: 'Identifier' }>} identifier */
    function variableOf(identifier) {
      return scopeChain(identifier)
        .flatMap((scope) => scope.variables)
        .find((variable) => variable.name === identifier.name);
    }

    /**
     * The vocabulary name a callee reaches: its own, the one it was imported or
     * destructured under, or the member read off a namespace import.
     */
    /**
     * @param {Extract<AstNode, { type: 'Identifier' }> | MemberNode} callee
     * @returns {string | undefined}
     */
    function vocabularyNameOf(callee) {
      if (callee.type === 'Identifier') return boundName(variableOf(callee), callee.name);
      // A computed member is a name only when it is written out as one.
      if (callee.computed && callee.property.type !== 'Literal') return;
      if (callee.object.type !== 'Identifier') return;
      const namespace =
        variableOf(callee.object)?.defs[0]?.node.type === 'ImportNamespaceSpecifier';
      return namespace ? staticName(callee.property) : undefined;
    }

    /**
     * Every expression a binding was given, which is not what an annotation
     * says it holds: `const basis: ServedChargeBasis = await response.json()`
     * declares away an `any`, and the declaration is the forgery. A later
     * assignment is the same widening one statement on, so both are asked —
     * a binding declared with a harmless initialiser and assigned the reading
     * afterwards is the shape that evades asking the declaration alone.
     */
    /**
     * @param {AstNode | undefined} node
     * @returns {AstNode[]}
     */
    function assignedValuesOf(node) {
      if (node?.type !== 'Identifier') return [];
      const variable = variableOf(node);
      if (variable === undefined) return [];
      const declaration = variable.defs[0]?.node;
      const declared =
        declaration?.type === 'VariableDeclarator' && declaration.init !== null
          ? [declaration.init]
          : [];
      return [
        ...declared,
        ...rebindings
          // Only assignments whose target is a bare identifier are collected.
          .filter(
            (rebinding) =>
              variableOf(
                /** @type {Extract<AstNode, { type: 'Identifier' }>} */ (rebinding.left)
              ) === variable
          )
          .map((rebinding) => rebinding.right),
      ];
    }

    /** Whether a callee's declarations are all outside first-party source. */
    /** @param {AstNode} callee */
    function declaredElsewhere(callee) {
      const symbol = checker.getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(callee));
      /** @type {readonly import('typescript').Declaration[]} */
      const declarations = symbol?.declarations ?? [];
      return (
        declarations.length > 0 &&
        declarations.every((declaration) => !isFirstParty(declaration.getSourceFile()))
      );
    }

    /** Predicate 1, over each vocabulary argument. Returns what it reported. */
    function reportUnnameableArguments() {
      /** @type {Set<AstNode>} */
      const reported = new Set();
      for (const call of vocabularyCalls) {
        for (const argument of call.arguments) {
          const what =
            unnameable(typeOf(argument)) ??
            assignedValuesOf(argument)
              .map((value) => unnameable(typeOf(value)))
              .find((reason) => reason !== undefined);
          if (what !== undefined) {
            reported.add(argument);
            context.report({ node: argument, messageId: 'unnameable', data: { what } });
          }
        }
      }
      return reported;
    }

    /** Predicate 2, over each member write. */
    function reportWriteThroughs() {
      for (const target of memberWrites) {
        const held = assignedValuesOf(rootIdentifier(target));
        if (held.some((value) => carriesBrand(typeOf(value)))) {
          context.report({ node: target, messageId: 'writeThrough' });
        }
      }
    }

    /** Predicate 3, over each call this codebase did not declare. */
    /** @param {ReadonlySet<AstNode>} reported */
    function reportLaundering(reported) {
      for (const call of ambientCalls) {
        if (reported.has(call) || !declaredElsewhere(call.callee)) continue;
        if (!carriesBrand(typeOf(call))) continue;
        const handed = call.arguments.some(
          (argument) => argument.type !== 'SpreadElement' && carriesBrand(typeOf(argument))
        );
        if (handed) {
          context.report({
            node: call,
            messageId: 'laundered',
            data: { callee: sourceCode.getText(call.callee) },
          });
        }
      }
    }

    return {
      /** @param {CallNode} node */
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' && node.callee.type !== 'MemberExpression') return;
        const called = vocabularyNameOf(node.callee);
        if (called !== undefined && vocabulary.has(called)) vocabularyCalls.push(node);
        else ambientCalls.push(node);
      },
      /** @param {Extract<import('eslint').Rule.Node, { type: 'AssignmentExpression' }>} node */
      AssignmentExpression(node) {
        if (node.left.type === 'MemberExpression') memberWrites.push(node.left);
        else if (node.left.type === 'Identifier') rebindings.push(node);
      },
      /** @param {Extract<import('eslint').Rule.Node, { type: 'UpdateExpression' }>} node */
      UpdateExpression(node) {
        if (node.argument.type === 'MemberExpression') memberWrites.push(node.argument);
      },
      // Deferred: a value can be forged after the call that consumes it is
      // parsed, and the mutating form usually is.
      'Program:exit'() {
        const reported = reportUnnameableArguments();
        if (vocabularyCalls.length === 0) return;
        reportWriteThroughs();
        reportLaundering(reported);
      },
    };
  },
};
