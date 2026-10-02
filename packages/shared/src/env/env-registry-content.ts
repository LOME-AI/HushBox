import { shippableEntries } from './client-shippable.ts';
import {
  Destination,
  Mode,
  envConfig,
  isAnyModeSecret,
  resolveRaw,
  type VariableConfig,
} from './env.config.ts';

/**
 * Recognises backend environment material inside a built artifact.
 *
 * Every public origin this repository ships is credential-free by design, so
 * the backend registry — its entry names, the credential-shaped placeholders
 * its non-production modes carry, and the Zod schema restating a subset of
 * those names — must never be served from one. Importing the top-level
 * `@hushbox/shared` barrel used to inline the backend entry names: it
 * re-exported a symbol declared alongside the registry, which pulled that
 * module into the graph, and the bundler kept that schema while dropping the
 * registry object itself.
 *
 * Derived from the registry rather than listed, so an entry added later is
 * covered without anyone remembering to add it.
 *
 * Node-only, and deliberately absent from the package barrel: it reads the
 * registry to build its patterns, so importing it from anything a browser app
 * bundles would inline the very thing it looks for.
 */

type Registry = Record<string, VariableConfig>;

const MODES = Object.values(Mode);

/** Values a frontend-destined entry carries legitimately ship, so they identify nothing. */
function frontendValues(shippable: ReadonlyMap<string, VariableConfig>): Set<string> {
  return new Set([...shippable.values()].flatMap((config) => literalValues(config)));
}

function literalValues(config: VariableConfig): string[] {
  const values = MODES.map((mode) => resolveRaw(config, mode)).filter(
    (value): value is string => typeof value === 'string' && value !== ''
  );
  return [...new Set(values)];
}

/**
 * What continues a token: identifier characters plus the hyphen that slug-shaped
 * values are built from.
 */
const TOKEN_CHAR_CLASS = String.raw`[\w$-]`;
const TOKEN_CHAR = new RegExp(String.raw`^${TOKEN_CHAR_CLASS}$`, 'u');

/** `charAt` past either end yields `''`, which is no token character. */
function extendsToken(neighbour: string, edge: string, tokenChar: RegExp): boolean {
  return tokenChar.test(neighbour) && tokenChar.test(edge);
}

/**
 * `source` contains `value` as a whole token — not buried inside a longer one.
 *
 * A bundler inlining a registry value emits it as a complete string literal, so
 * its edges are quotes; a match that a neighbouring character extends is some
 * other identifier that happens to start or end with these characters. Without
 * this, the short slug `CF_ACCESS_TEAM_DOMAIN` carries in development matches
 * the web app's IndexedDB database name, and every artifact holding that name
 * is reported as leaking the registry.
 *
 * What continues a token is the caller's, because it is the one thing that
 * varies with the text being read: minified JavaScript builds identifiers out
 * of `$`, and a value written into a compose file never does while its dots
 * separate a path or a host rather than continue a name. Exported for the
 * reader that needs the other class, `scripts/lib/stack/compose-literals.test.ts`.
 */
export function includesAsToken(source: string, value: string, tokenChar: RegExp): boolean {
  for (let at = source.indexOf(value); at !== -1; at = source.indexOf(value, at + 1)) {
    const openEnded = extendsToken(source.charAt(at - 1), value.charAt(0), tokenChar);
    const runOn = extendsToken(source.charAt(at + value.length), value.slice(-1), tokenChar);
    if (!openEnded && !runOn) return true;
  }
  return false;
}

/**
 * A registry entry as a bundler emits it: the name in object-key position,
 * followed by its `to` declaration. Matching the declaration rather than the
 * bare name is what lets short entries like `CI` be covered at all — the bare
 * name occurs in a parser's function name, a Unicode property alias table and a
 * bundler's `process.env.NODE_ENV` rewrite, none of which is a leak. Tolerant of
 * quoting and whitespace, so it reads minified and unminified output alike.
 *
 * Anchored on its left so a longer name that merely ends with this one is not
 * read as this one: several backend entries are suffixes of the frontend
 * `VITE_*` entries that legitimately ship — `VAPID_PUBLIC_KEY` inside
 * `VITE_VAPID_PUBLIC_KEY` — and would otherwise be reported on every artifact
 * carrying the frontend registry.
 */
function declarationPattern(name: string): RegExp {
  return new RegExp(
    String.raw`(?<!${TOKEN_CHAR_CLASS})["']?${name}["']?\s*:\s*\{\s*to\s*:\s*\[`,
    'u'
  );
}

/**
 * The name in object-key position, with nothing said about what follows it.
 *
 * The Zod schema restating a subset of the registry's names minifies to key
 * shapes — `NAME:E().min(1)` is one of several — that carry no `to`
 * declaration, no placeholder literal and no destination marker, so the key
 * itself is the only thing a leak of it shares with a leak of the registry.
 * Anchored on its left for the same reason the declaration pattern is: several
 * backend entries are suffixes of the `VITE_*` entries that legitimately ship.
 */
function keyPositionPattern(name: string): RegExp {
  return new RegExp(String.raw`(?<!${TOKEN_CHAR_CLASS})["']?${name}["']?\s*:`, 'u');
}

/**
 * How many distinct backend names in key position make an artifact a leak
 * rather than a coincidence.
 *
 * A bare name says far less than a declaration does, so one of them is not
 * evidence: an object field can be spelled like an entry by accident. The leak
 * this tier exists for states the whole backend surface at once, while a
 * browser bundle built from the split module graph names none of them.
 */
const NAME_CLUSTER_SIZE = 3;

/**
 * The credential-bearing names this artifact states as object keys, once there
 * are enough of them to mean something. Names the declaration tier already
 * reported are counted towards the cluster and left out of its output, so a
 * leaked registry is not described twice.
 *
 * Only entries holding a credential are counted, and that is what lets the tier
 * match bare names at all. The frontend legitimately builds its env-utilities
 * context out of backend entry names — `NODE_ENV`, `CI` and `E2E` are the three
 * registry-declared `createEnvUtilities` reads — so counting every backend name
 * would report every browser bundle in the repository. None of those three
 * carries a credential; every name in the leaked schema's cluster does.
 *
 * The price of that narrowing, accepted knowingly: a cluster of purely
 * non-credential backend names in the bare-key shape is covered by no tier at
 * all — the declaration, placeholder and marker tiers all read shapes the Zod
 * schema does not carry, which is the whole reason this tier exists. What makes
 * the trade acceptable is the leak class itself, a whole-object inline of the
 * backend surface: it states the credential-bearing names alongside the rest,
 * so a real leak trips the cluster on its credential names.
 */
function nameCluster(
  confidential: readonly (readonly [string, VariableConfig])[],
  declared: ReadonlySet<string>,
  source: string
): string[] {
  const stated = confidential
    .filter(([name, config]) => isAnyModeSecret(config) && keyPositionPattern(name).test(source))
    .map(([name]) => name);
  if (stated.length < NAME_CLUSTER_SIZE) return [];
  return stated.filter((name) => !declared.has(name)).map((name) => `${name} in key position`);
}

/**
 * Entry names are object keys in the registry source, so they are already
 * identifier-shaped; anything else reaches {@link declarationPattern} and
 * {@link keyPositionPattern} as raw regex source, where it either fails to
 * construct or matches names the registry never declared, and failing here says
 * so rather than silently dropping it.
 */
const ENTRY_NAME = /^[A-Za-z_$][\w$]*$/u;

/**
 * Hosts that name only the machine the process is already on.
 *
 * `URL.hostname` brackets an IPv6 literal, which is why the loopback address is
 * matched in that form rather than bare.
 */
const LOOPBACK_HOST = /^(?:(?:[\w-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\])$/u;

/**
 * The value is nothing but an origin, and that origin is loopback — a local
 * emulator's address, which two credential-bearing entries carry as their
 * stand-in outside production.
 *
 * Such a value identifies nothing: no host another machine can reach, no
 * account, no tenant, no credential. So it fails the premise the placeholder
 * tier rests on — that a stand-in exists nowhere else — and matching it reports
 * artifacts that carry no registry content at all. A dev-mode `_headers` names
 * one of them in every `connect-src` it writes.
 *
 * Both halves are load-bearing, and each is the other's soundness guard.
 * Loopback alone would drop the database entries, whose stand-ins are loopback
 * too and carry their credentials in userinfo; origin-shape alone would drop a
 * routable origin, which names a remote service and can identify the account it
 * belongs to. Equality against `origin` is what makes "nothing but" exact:
 * userinfo, a path, a query and a fragment all fall outside it, and a scheme
 * with no origin of its own yields `'null'`, which no value equals.
 */
function isLoopbackOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return LOOPBACK_HOST.test(url.hostname) && value === url.origin;
}

/**
 * The credential-shaped placeholder a credential-bearing entry carries in the
 * modes where it is not the credential itself. Such a stand-in exists nowhere
 * else and is worth matching literally — which survives a bundler emitting the
 * registry in a shape the declaration pattern no longer recognises. Except
 * where it does exist elsewhere: see {@link isLoopbackOrigin}.
 *
 * The `secret(...)` marker is read in every mode, not production alone: entries
 * exist that carry one in a CI mode and have no production value at all, and
 * reading production only would drop their literals from the needle set — the
 * derivation property this module claims does not survive a gate that a legal
 * registry shape can walk past.
 */
function placeholderValues(config: VariableConfig, shipped: Set<string>): string[] {
  if (!isAnyModeSecret(config)) return [];
  return literalValues(config).filter((value) => !shipped.has(value) && !isLoopbackOrigin(value));
}

const QUOTE = /["'`]/.source;

/**
 * A non-frontend destination named inside a `to` array, in either shape a build
 * leaves behind: the value inlined as a string literal, or a property read off
 * the destination table. Which one a build emits is its own choice, so both are
 * matched and neither choice can leave this leg quiet.
 *
 * Every quote the language allows on a string literal is accepted, in the
 * inlined value and in a computed property read alike: which quote a printer
 * reaches for is a formatting choice nothing binds it to, so a pattern spelling
 * the subset one printer happened to emit is a guard that goes quiet the moment
 * another prints the same artifact. A quoted property key is not a string
 * literal position and carries only what an object key may legally be quoted
 * with, which is why `to` keeps the narrower class.
 *
 * The identifier the table is bound to is minifier-chosen, so naming that
 * identifier is what would leave this pattern matching nothing after the next
 * minifier release. The property key survives for the same reason `to` and the
 * entry names do: property names are renamed only under an opt-in this repo
 * does not enable, and a build that renamed them would take every tier here
 * with it.
 *
 * Read rather than bare name, because a destructured binding is a local and a
 * minifier renames locals: a bare `Backend` is a shape no artifact keeps, so
 * matching it would buy nothing and cost false positives.
 */
function destinationMarker(key: string, value: string): RegExp {
  return new RegExp(
    String.raw`["']?to["']?\s*:\s*\[[^\]]*(?:(${QUOTE})${value}\1|(?:\.\s*|\[\s*${QUOTE})${key}(?![\w$]))`,
    'u'
  );
}

/** The non-frontend destinations this artifact declares a `to` array for. */
function destinationMarkersIn(source: string): string[] {
  return Object.entries(Destination)
    .filter(([, value]) => value !== Destination.Frontend)
    .filter(([key, value]) => destinationMarker(key, value).test(source))
    .map(([, value]) => `${value} destination marker`);
}

/** The strings that identify one backend-confidential entry inside an artifact. */
function entryMatches(
  name: string,
  config: VariableConfig,
  shipped: Set<string>,
  source: string
): string[] {
  const declared = declarationPattern(name).test(source) ? [name] : [];
  const placeholder = placeholderValues(config, shipped).some((value) =>
    includesAsToken(source, value, TOKEN_CHAR)
  )
    ? [`${name} value`]
    : [];
  return [...declared, ...placeholder];
}

function assertEntryName(name: string): void {
  if (!ENTRY_NAME.test(name)) {
    throw new Error(`environment registry entry ${name} is not an identifier`);
  }
}

/**
 * The registry content present in `source`, named by what matched. An empty
 * array is the artifact carrying none of what these tiers recognise.
 */
export function envRegistryContentIn(source: string, registry: Registry = envConfig): string[] {
  const shippable = shippableEntries(registry);
  const shipped = frontendValues(shippable);
  const confidential = Object.entries(registry).filter(([name]) => !shippable.has(name));
  for (const [name] of confidential) assertEntryName(name);
  const entries = confidential.flatMap(([name, config]) =>
    entryMatches(name, config, shipped, source)
  );
  const declared = new Set(entries);
  return [
    ...entries,
    ...destinationMarkersIn(source),
    ...nameCluster(confidential, declared, source),
  ];
}
