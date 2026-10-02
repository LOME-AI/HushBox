/**
 * How a money brand is recognised, for the two places that have to agree on it:
 * the `no-forged-money-input` rule, which asks it of arguments and call results,
 * and the completeness gate beside it, which asks it of the vocabulary's own
 * signatures to derive the domain the rule protects.
 *
 * It is one module because the two answers must be the same answer. If the gate
 * called a type branded and the rule did not, the rule would be protecting a
 * different set of functions than the one the gate proved complete.
 *
 * Nothing here reads source text: a brand is found through the checker, so a
 * brand introduced tomorrow is found without editing anything.
 */
import ts from 'typescript';

/**
 * One level past the deepest shape either consumer needs: `Promise<readonly
 * Row[]>` is answered at three, measured. Pinned by a test that plants a brand
 * at exactly this depth, so lowering it cannot narrow the walk silently.
 */
const MAX_TYPE_DEPTH = 4;

/**
 * A brand: a property keyed by a unique symbol declared in first-party source.
 * `node_modules` is excluded because a dependency's own symbol keys — the
 * well-known iterator ones, Playwright's dispose symbols — are not our brands.
 */
/** @param {import('typescript').Symbol} property */
function isBrand(property) {
  return (
    String(property.escapedName).startsWith('__@') &&
    // No fallback for a symbol-keyed property with no declaration: answering
    // "not a brand" for a property we could not inspect fails OPEN, on the one
    // check the vocabulary's refusals rest on. A throw is the loud answer.
    /** @type {import('typescript').Declaration[]} */ (property.declarations).some((declaration) =>
      isFirstParty(declaration.getSourceFile())
    )
  );
}

/** A source file this codebase owns, rather than one a dependency shipped. */
/** @param {import('typescript').SourceFile} sourceFile */
export function isFirstParty(sourceFile) {
  return !sourceFile.fileName.includes('node_modules');
}

/**
 * Asks whether a type carries a brand in one of four places, bounded to four
 * levels deep: on its own properties, on a union or intersection constituent,
 * on a type argument, or on its NUMERIC index type. What it therefore does not
 * answer, so the limit is not assumed away: a brand reachable only through a
 * STRING index signature, one reachable only as a callback parameter's type,
 * and one sitting deeper than the four levels below.
 *
 * Memoised per checker because the rule asks it of every argument and every
 * call result in a file, and the walk fans out over a type's properties.
 */
/** @param {import('typescript').TypeChecker} checker */
export function brandDetection(checker) {
  /** @type {Map<import('typescript').Type, boolean>} */
  const answers = new Map();

  // `types` is declared on the union/intersection subtype only, and the walk
  // reads it off any type it is handed.
  /** @param {import('typescript').Type & { types?: readonly import('typescript').Type[] }} type */
  const constituents = (type) => {
    // `getTypeArguments` answers `undefined`, not an empty array, for a type
    // whose type node is an instantiation type query — `typeof f<T>`, which
    // @types/node and vitest both declare members of. Spreading that answer
    // aborts the whole ESLint run on code that merely has one in scope.
    // `getTypeArguments` is declared over the type-reference subtype and answers
    // an empty list for anything else, which is the answer the walk wants.
    const nested = [
      ...(type.types ?? []),
      ...(checker.getTypeArguments(/** @type {import('typescript').TypeReference} */ (type)) ?? []),
    ];
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (index !== undefined) nested.push(index);
    return [
      ...nested,
      ...checker.getPropertiesOfType(type).map((property) => checker.getTypeOfSymbol(property)),
    ];
  };

  /**
   * @param {import('typescript').Type} type
   * @param {number} depth
   * @param {Set<import('typescript').Type>} seen
   * @returns {boolean}
   */
  const carries = (type, depth, seen) => {
    if (depth > MAX_TYPE_DEPTH || seen.has(type)) return false;
    seen.add(type);
    if (checker.getPropertiesOfType(type).some((property) => isBrand(property))) return true;
    return constituents(type).some((child) => carries(child, depth + 1, seen));
  };

  /** @param {import('typescript').Type} type */
  return (type) => {
    const cached = answers.get(type);
    if (cached !== undefined) return cached;
    const answer = carries(type, 0, new Set());
    answers.set(type, answer);
    return answer;
  };
}
