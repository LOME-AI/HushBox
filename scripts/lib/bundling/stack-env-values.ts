/**
 * What a built bundle bakes, held against the generated frontend env file of
 * the stack its build was invoked for.
 *
 * Reachable from a Vite configuration through the bundle verifier, so every
 * specifier here names the file Node itself resolves.
 */
import { promises as fs } from 'node:fs';

/**
 * The quote characters a string literal can arrive under. A minified build
 * emits the inlined env values as template literals, so the backtick sits here
 * beside the ordinary quotes.
 */
export const STRING_QUOTE_CHARS = '\'"`';

export const STRING_QUOTE = `[${STRING_QUOTE_CHARS}]`;

/**
 * The prefix this comparison covers: the one a generated frontend env file
 * writes its entries under. An entry under any other prefix sits outside the
 * comparison entirely — declared on one side or baked on the other, it is
 * checked against nothing here.
 */
const FRONTEND_ENV_PREFIX = 'VITE_';

/** A written value under the quote pair the generator wrapped it in, if it wrapped one. */
const QUOTED_ENV_VALUE = /^(['"])(.*)\1$/u;

/** Where the text inside that pair sits in a match of it. */
const QUOTED_ENV_TEXT = 2;

/**
 * A generated value as the loader that baked it reads one: the surrounding
 * quote pair is the generator's escaping, and the contents are taken verbatim.
 * Read this way rather than unescaped, because what the file supplies a loader
 * is what the build had to bake.
 */
function loadedEnvValue(raw: string): string {
  return QUOTED_ENV_VALUE.exec(raw)?.[QUOTED_ENV_TEXT] ?? raw;
}

/**
 * What the generator wrote for the stack a build was invoked for, read out of
 * the file it wrote it to.
 *
 * Derived rather than written down: a list of the values that vary between
 * stacks would be a closed set, and would stop covering a value on the day the
 * registry gains one — which is the failure this comparison exists to catch.
 *
 * @param envFile the generated frontend env file, absolute. A missing one
 *   throws rather than yielding an empty set, which would pass every bundle.
 */
export async function declaredStackEnvValues(envFile: string): Promise<Map<string, string>> {
  const source = await fs.readFile(envFile, 'utf8');
  const declared = new Map<string, string>();
  for (const line of source.split('\n')) {
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key.startsWith(FRONTEND_ENV_PREFIX)) continue;
    declared.set(key, loadedEnvValue(line.slice(separator + 1).trim()));
  }
  return declared;
}

/**
 * A frontend variable in object-key position at the literal a bundler inlined
 * it to, as both an unminified build (quoted key, quoted value) and a minified
 * one (bare key, template literal) emit it. Anchored on its left so a longer
 * identifier ending in a variable's name cannot pass for one.
 *
 * Global because every chunk that reads the environment bakes the whole object
 * and each occurrence has to be looked at; `matchAll` also refuses a non-global
 * pattern.
 */
const BAKED_FRONTEND_VALUE = new RegExp(
  String.raw`(?<![\w$])(?<keyQuote>${STRING_QUOTE})?(?<key>${FRONTEND_ENV_PREFIX}[A-Z0-9_]+)` +
    String.raw`\k<keyQuote>?\s*:\s*(?<quote>${STRING_QUOTE})(?<baked>[^${STRING_QUOTE_CHARS}]*)\k<quote>`,
  'gu'
);

/**
 * Holds the bundle to the stack the build was invoked for: what it bakes
 * against what the generator wrote for that stack, in both directions.
 *
 * A build under turbo bakes the generated file alone, so for it this holds
 * trivially. A build that runs the bundler directly bakes every prefixed
 * variable its step's environment holds ahead of the file, and this is the
 * check that sees one the file does not declare: a bundle carrying another
 * stack's addresses, or a value nobody registered, is invisible until a user
 * meets it.
 *
 * Violations name the values. Every one of them is a value the bundle already
 * serves to anyone who loads it, so naming one discloses nothing the artifact
 * does not.
 *
 * @param overridden keys the build declares it bakes in place of the file. Each
 *   may carry another value, and only one the file declares: a key the file
 *   does not declare is reported whatever the build says it overrides.
 */
export function checkStackEnvValues(
  sources: ReadonlyMap<string, string>,
  declared: ReadonlyMap<string, string>,
  overridden: ReadonlySet<string>
): string[] {
  const baked = bakedFrontendValues(sources);
  const violations = [...baked]
    .filter(([key]) => !(overridden.has(key) && declared.has(key)))
    .flatMap(([key, carriers]) => bakedValueViolations(key, carriers, declared.get(key)));
  for (const key of declared.keys()) {
    if (!baked.has(key)) {
      violations.push(
        `no built artifact bakes ${key}, which the stack this build was invoked for ` +
          `declares — nothing in this bundle read the generated environment file`
      );
    }
  }
  return violations;
}

/**
 * Every frontend value the bundle bakes, by variable and then by value, at the
 * files carrying each.
 *
 * The carriers are a set: a chunk that reads the environment bakes the whole
 * object, a bundler emits that object more than once in one chunk, and listing
 * a file once per occurrence tells a reader nothing it can act on.
 */
function bakedFrontendValues(
  sources: ReadonlyMap<string, string>
): Map<string, Map<string, Set<string>>> {
  const baked = new Map<string, Map<string, Set<string>>>();
  for (const [relativePath, source] of sources) {
    for (const match of source.matchAll(BAKED_FRONTEND_VALUE)) {
      // Both groups take part in every match of the pattern, so neither falls back.
      /* v8 ignore next */
      const key = match.groups?.['key'] ?? '';
      /* v8 ignore next */
      const value = match.groups?.['baked'] ?? '';
      const carriers = baked.get(key) ?? new Map<string, Set<string>>();
      carriers.set(value, (carriers.get(value) ?? new Set<string>()).add(relativePath));
      baked.set(key, carriers);
    }
  }
  return baked;
}

/** What one baked variable's values are, against the one value the stack declares for it. */
function bakedValueViolations(
  key: string,
  carriers: ReadonlyMap<string, ReadonlySet<string>>,
  expected: string | undefined
): string[] {
  return [...carriers]
    .filter(([value]) => value !== expected)
    .map(([value, carrying]) =>
      expected === undefined
        ? `built artifact bakes ${key}="${value}", which the stack this build was invoked ` +
          `for declares nothing for: ${[...carrying].join(', ')} — this build read some ` +
          `other stack's generated environment file`
        : `built artifact bakes ${key}="${value}" where the stack this build was invoked ` +
          `for declares "${expected}": ${[...carrying].join(', ')}`
    );
}
