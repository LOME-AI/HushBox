/**
 * The money vocabulary's DOMAIN, derived through the compiler's own checker:
 * every exported function that takes a branded value, produces one, or takes
 * the context a read is made from — plus the callable exports it does NOT
 * admit, which is what lets the list be gated by exhaustion rather than trusted.
 *
 * It sits beside `money-brand.mjs` rather than inside a test because two suites
 * ask it — the list gate over the real modules, and the walk's bounds over
 * fixtures — and a derivation copied into both could answer differently in
 * each, which is the one thing the single `brandDetection` exists to prevent.
 *
 * Nothing here reads source text. A brand is recognised structurally, so an
 * alias, an arrow function or a re-export cannot hide a member; the bounds of
 * that recognition are `money-brand.mjs`'s and are stated there.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { brandDetection } from './money-brand.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository root, four levels up from `packages/config/eslint-extensions/rules`. */
export const REPO_ROOT = path.resolve(here, '..', '..', '..', '..');

/** The two modules the vocabulary is published from. */
export const VOCABULARY_MODULES = ['scripts/lib/money/money.ts', 'e2e/helpers/exact-money.ts'];

/**
 * The type a read is made FROM. It is matched as the RESOLVED symbol of a
 * parameter's type, so an alias, a re-export or a renamed import in parameter
 * position all still answer to it — the thing a text-matching derivation
 * could not do.
 */
const REQUEST_CONTEXT = 'APIRequestContext';

/** @param {readonly string[]} files */
function programOver(files) {
  const configPath = path.join(REPO_ROOT, 'e2e/tsconfig.json');
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    path.dirname(configPath)
  );
  return ts.createProgram({
    rootNames: files,
    options: { ...parsed.options, noEmit: true, skipLibCheck: true },
  });
}

/**
 * Both answers from one program: what is derived, and what is merely callable.
 *
 * @param {readonly string[]} files
 * @returns {{ domain: string[], callable: string[] }}
 */
export function moneyModuleExports(files) {
  const program = programOver(files);
  const checker = program.getTypeChecker();
  const carriesBrand = brandDetection(checker);

  /** @param {ts.Signature} signature */
  const inDomain = (signature) => {
    const parameters = signature
      .getParameters()
      .map((parameter) => checker.getTypeOfSymbol(parameter));
    return (
      parameters.some((type) => carriesBrand(type)) ||
      carriesBrand(signature.getReturnType()) ||
      parameters.some(
        (type) => (type.aliasSymbol ?? type.getSymbol())?.getName() === REQUEST_CONTEXT
      )
    );
  };

  // Each export is carried with the declaration its type must be asked AT; a
  // parameter's is asked of the symbol itself, since a signature's parameters
  // need no location and asking for one would add a fallback no input has ever
  // reached.
  //
  // A file the program does not hold, and a file that declares no module, are
  // refused by name: the derivation gates the vocabulary list, so an input it
  // cannot read means the gate cannot answer, and the checker's own failure on
  // such an input would name nothing.
  /**
   * @param {string} file
   * @returns {{ symbol: ts.Symbol, declaration: ts.Declaration }[]}
   */
  const exportsOf = (file) => {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) {
      throw new Error(`Money vocabulary module is not in the program: ${file}`);
    }
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol === undefined) {
      throw new Error(`Money vocabulary module declares no module: ${file}`);
    }
    return checker
      .getExportsOfModule(moduleSymbol)
      .filter((exported) => exported.declarations !== undefined)
      .map((exported) => ({
        symbol: exported,
        // The filter is what establishes the list, and an export declared at all
        // has a first declaration — which is where its type must be asked.
        declaration: /** @type {import('typescript').Declaration} */ (
          /** @type {import('typescript').Declaration[]} */ (exported.declarations)[0]
        ),
      }));
  };

  /** @type {Set<string>} */
  const domain = new Set();
  /** @type {Set<string>} */
  const callable = new Set();
  for (const { symbol, declaration } of files.flatMap((file) => exportsOf(file))) {
    const signatures = checker.getTypeOfSymbolAtLocation(symbol, declaration).getCallSignatures();
    if (signatures.length === 0) continue;
    callable.add(symbol.getName());
    if (signatures.some((signature) => inDomain(signature))) domain.add(symbol.getName());
  }
  return { domain: [...domain].toSorted(), callable: [...callable].toSorted() };
}

/** @param {readonly string[]} files */
export function moneyVocabularyDomain(files) {
  return moneyModuleExports(files).domain;
}

/**
 * The callable exports neither derived into the domain nor classified into a
 * named non-domain group. The derivation cannot be complete — it misses a brand
 * behind a string index, and a context it resolves to anything but
 * `APIRequestContext` — so the guarantee is exhaustion instead: whatever the
 * derivation does not admit has to be classified by hand, where it is visible.
 */
/**
 * @param {readonly string[]} files
 * @param {readonly string[]} classified
 */
export function unclassifiedExports(files, classified) {
  const { domain, callable } = moneyModuleExports(files);
  const known = new Set([...domain, ...classified]);
  return callable.filter((name) => !known.has(name));
}
