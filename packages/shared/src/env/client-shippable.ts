import { Destination, Mode, envConfig, getDestinations } from './env.config.ts';
import type { LeakImpact, SecretStore, VariableConfig } from './env-types.ts';

/**
 * Which registry entries a client build may carry, and the rule every one of
 * them must pass.
 *
 * A frontend value is not confined to the chunks that read it: client code reads
 * env by index, so the bundler inlines the whole client env object at every
 * access site, and every frontend value is served from every origin that ships a
 * client bundle. The rule is therefore judged per entry, never per bundle.
 *
 * Node-only and absent from the package barrel: it reads the registry, so
 * anything a browser app bundles that imported it would inline the registry.
 */

type Registry = Readonly<Record<string, VariableConfig>>;

/** The prefix the bundler filters client env by; a key without it never ships. */
const CLIENT_PREFIX = 'VITE_';

/**
 * Where a frontend credential may live: at repository level, which a build job
 * resolves under whatever environment it runs, or in no GitHub secret at all.
 */
const SHIPPABLE_STORES: ReadonlySet<SecretStore> = new Set(['github:repository', 'worker-only']);

/** Leak impacts no client artifact may carry, whichever build bakes it in. */
const UNSHIPPABLE_IMPACTS: ReadonlySet<LeakImpact> = new Set(['companyEnding', 'severe']);

function entriesRoutedTo(
  registry: Registry,
  destination: Destination
): ReadonlyMap<string, VariableConfig> {
  return new Map(
    Object.entries(registry).filter(([, config]) =>
      Object.values(Mode).some((mode) => getDestinations(config, mode).includes(destination))
    )
  );
}

/**
 * Every entry routed to the frontend in any mode — the entries a client build
 * may carry. {@link frontendRoutingRefusals} is the rule each must pass.
 */
export function shippableEntries(
  registry: Registry = envConfig
): ReadonlyMap<string, VariableConfig> {
  return entriesRoutedTo(registry, Destination.Frontend);
}

/**
 * Every entry routed into the native app build in any mode: values a native
 * build compiles into the application outside the web bundle, so they reach
 * every device that installs it.
 */
export function nativeBakedEntries(
  registry: Registry = envConfig
): ReadonlyMap<string, VariableConfig> {
  return entriesRoutedTo(registry, Destination.Native);
}

function refusalsOf(name: string, config: VariableConfig): string[] {
  const refusals: string[] = [];
  if (!name.startsWith(CLIENT_PREFIX)) {
    refusals.push(
      `${name}: a frontend key must start with ${CLIENT_PREFIX}, the prefix the bundler ships`
    );
  }
  const credential = config.credential;
  if (credential === undefined) return refusals;
  if (UNSHIPPABLE_IMPACTS.has(credential.leakImpact)) {
    refusals.push(`${name}: a ${credential.leakImpact} credential is routed to the frontend`);
  }
  if (!SHIPPABLE_STORES.has(credential.store)) {
    refusals.push(`${name}: a credential held in ${credential.store} is routed to the frontend`);
  }
  return refusals;
}

/**
 * Each way a shippable entry breaks the rule, naming the entry.
 *
 * A credential with a severe or company-ending leak impact never ships, and
 * neither does one held in a GitHub environment: an environment-held value
 * resolves to the empty string under every other environment, so where it
 * reaches a bundle depends on which environment a build job happens to run
 * under. Credentials are read off the `credential` declaration, which only an
 * entry carrying a `secret(...)` marker holds; a credential written as a plain
 * literal is outside this rule's reach.
 */
export function frontendRoutingRefusals(registry: Registry = envConfig): string[] {
  return [...shippableEntries(registry)].flatMap(([name, config]) => refusalsOf(name, config));
}

/**
 * Each native-routed entry carrying a credential no device may hold: the native
 * build compiles the value into an app anyone can unpack.
 */
export function nativeRoutingRefusals(registry: Registry = envConfig): string[] {
  return [...nativeBakedEntries(registry)].flatMap(([name, { credential }]) =>
    credential !== undefined && UNSHIPPABLE_IMPACTS.has(credential.leakImpact)
      ? [`${name}: a ${credential.leakImpact} credential is routed into the native build`]
      : []
  );
}
