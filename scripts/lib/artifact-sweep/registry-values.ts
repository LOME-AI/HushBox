/**
 * Which production values the shipped-artifact sweep looks for, derived from
 * the secret declarations: the env registry and the CI credentials beside it.
 *
 * Every production secret is looked for unless it ships by design: a registry
 * entry routed to the frontend, whose value every client bundle carries; one
 * routed into the native build, which compiles it into the app; or a CI
 * identifier whose declaration names where it ships. A value equal to a shipped
 * one is not looked for when its leak is no worse than the shipped entry's — it
 * already ships, under the other entry's name — and is looked for otherwise, so
 * a credential pasted into its public counterpart still fails. The rest are
 * needles.
 *
 * The publishing jobs run under {@link PUBLISHING_ENVIRONMENT}, so a secret held
 * in any other environment is unreadable there and is reported unswept rather
 * than silently dropped: a job that cannot read a value cannot bake it into what
 * it builds, and committed source is scanned by the repository-wide gitleaks
 * gate.
 */
import {
  envConfig,
  isSecret,
  Mode,
  resolveRaw,
  type VariableConfig,
} from '../../../packages/shared/src/env/env.config.js';
import {
  CI_IDENTIFIER_DECLARATIONS,
  CI_SECRETS,
} from '../../../packages/shared/src/env/ci-secrets.js';
import {
  frontendRoutingRefusals,
  nativeBakedEntries,
  nativeRoutingRefusals,
  shippableEntries,
} from '../../../packages/shared/src/env/client-shippable.js';
import {
  githubEnvironmentOf,
  type Credential,
  type LeakImpact,
  type SecretStore,
} from '../../../packages/shared/src/env/env-types.js';

type Registry = Readonly<Record<string, VariableConfig>>;

type Env = Readonly<Record<string, string | undefined>>;

/** The GitHub environment every job that publishes a client artifact declares. */
export const PUBLISHING_ENVIRONMENT = 'production';

/**
 * The shortest value the sweep looks for. Below it a value is an identifier —
 * a region, a project name, an account handle — rather than key material, and a
 * hit in megabytes of minified code is coincidence rather than evidence; a
 * random credential of useful strength is longer.
 */
export const SWEEP_LENGTH_FLOOR = 16;

/** The declarations a sweep derives from; each defaults to the repository's own. */
export interface SweepSources {
  readonly registry?: Registry;
  readonly ciSecrets?: Readonly<Record<string, Credential>>;
  readonly ciIdentifiers?: Readonly<Record<string, { readonly shipsIn?: string }>>;
}

interface Binding {
  /** The variable the sweep step binds and reads. */
  readonly key: string;
  /** The GitHub secret holding the production value. */
  readonly secretName: string;
}

interface NotSwept {
  readonly key: string;
  readonly reason: string;
}

export interface Needle {
  readonly key: string;
  readonly value: string;
}

interface SweepPlan {
  readonly needles: readonly Needle[];
  readonly notSwept: readonly NotSwept[];
  /** Client routing the registry refuses; any one fails the sweep. */
  readonly refusals: readonly string[];
}

/** How a declared value reaches a client artifact, if it does. */
type Shipping = 'not' | 'as-is' | 'decoded';

/** One production secret the sweep could bind, with what deciding its fate needs. */
interface Declaration extends Binding {
  /** Absent for an identifier, which the job that ships it reads by construction. */
  readonly store?: SecretStore;
  readonly leakImpact: LeakImpact;
  readonly shipping: Shipping;
}

/** Ordered by what a leak costs, so a comparison reads as "no worse than". */
const LEAK_SEVERITY: Readonly<Record<LeakImpact, number>> = {
  nuisance: 0,
  expensive: 1,
  severe: 2,
  companyEnding: 3,
};

function registryDeclarations(registry: Registry): Declaration[] {
  const frontend = shippableEntries(registry);
  const native = nativeBakedEntries(registry);
  return Object.entries(registry).flatMap(([key, config]): Declaration[] => {
    const raw = resolveRaw(config, Mode.Production);
    if (!isSecret(raw)) return [];
    const { credential } = config;
    if (credential === undefined) {
      throw new Error(`${key} holds a production secret but declares no credential`);
    }
    let shipping: Shipping = 'not';
    if (native.has(key)) shipping = 'decoded';
    else if (frontend.has(key)) shipping = 'as-is';
    return [
      {
        key,
        secretName: raw.name,
        store: credential.store,
        leakImpact: credential.leakImpact,
        shipping,
      },
    ];
  });
}

function declarations(sources: SweepSources): Declaration[] {
  const ciSecrets = Object.entries(sources.ciSecrets ?? CI_SECRETS).map(
    ([key, credential]): Declaration => ({
      key,
      secretName: key,
      store: credential.store,
      leakImpact: credential.leakImpact,
      shipping: 'not',
    })
  );
  // An identifier grants nothing, so it is bound only to admit the value it ships.
  const shippedIdentifiers = Object.entries(sources.ciIdentifiers ?? CI_IDENTIFIER_DECLARATIONS)
    .filter(([, identifier]) => identifier.shipsIn !== undefined)
    .map(
      ([key]): Declaration => ({ key, secretName: key, leakImpact: 'nuisance', shipping: 'as-is' })
    );
  return [
    ...registryDeclarations(sources.registry ?? envConfig),
    ...ciSecrets,
    ...shippedIdentifiers,
  ];
}

function unreadableReason(store: SecretStore | undefined): string | undefined {
  if (store === undefined) return undefined;
  const environment = githubEnvironmentOf(store);
  if (environment === undefined) {
    return 'no GitHub secret stores it; the run that builds or deploys mints it';
  }
  if (environment === 'repository' || environment === PUBLISHING_ENVIRONMENT) return undefined;
  return `held only in the ${environment} GitHub environment, which a job running under ${PUBLISHING_ENVIRONMENT} cannot read`;
}

function partition(sources: SweepSources): { bound: Declaration[]; unbound: NotSwept[] } {
  const bound: Declaration[] = [];
  const unbound: NotSwept[] = [];
  for (const declaration of declarations(sources)) {
    const reason = unreadableReason(declaration.store);
    if (reason === undefined) bound.push(declaration);
    else unbound.push({ key: declaration.key, reason });
  }
  return { bound, unbound };
}

/**
 * Every production secret the sweep step binds, and every one it cannot, with
 * the reason. The generated `artifact-sweep-env` block renders `bound`.
 */
export function sweepBindings(sources: SweepSources = {}): {
  bound: Binding[];
  unbound: NotSwept[];
} {
  const { bound, unbound } = partition(sources);
  return { bound: bound.map(({ key, secretName }) => ({ key, secretName })), unbound };
}

/** The string fields of a base64-encoded JSON document, or nothing when it is not one. */
function decodedJsonStrings(value: string): string[] {
  let document: unknown;
  try {
    document = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    // Not base64 of a JSON document: the value ships only as itself.
    return [];
  }
  const strings: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') strings.push(node);
    else if (node !== null && typeof node === 'object') {
      for (const child of Object.values(node)) visit(child);
    }
  };
  visit(document);
  return strings;
}

/**
 * What one shipped value puts in an artifact: itself, and, where the native
 * build decodes it into the app, the fields of the document it decodes to.
 */
function shippedForms(value: string, shipping: Shipping): string[] {
  return shipping === 'decoded' ? [value, ...decodedJsonStrings(value)] : [value];
}

interface Shipped {
  readonly entry: string;
  readonly leakImpact: LeakImpact;
}

/** Each value that ships, mapped to the most severe declaration shipping it. */
function shippedValues(
  env: Env,
  bound: readonly Declaration[],
  registry: Registry
): Map<string, Shipped> {
  const shipped = new Map<string, Shipped>();
  const add = (value: string, entry: string, leakImpact: LeakImpact): void => {
    const known = shipped.get(value);
    if (known === undefined || LEAK_SEVERITY[leakImpact] > LEAK_SEVERITY[known.leakImpact]) {
      shipped.set(value, { entry, leakImpact });
    }
  };
  for (const { key, leakImpact, shipping } of bound) {
    const value = env[key];
    if (shipping === 'not' || value === undefined || value === '') continue;
    for (const form of shippedForms(value, shipping)) add(form, key, leakImpact);
  }
  // A literal is no credential: it ships with nothing to leak.
  for (const [entry, config] of [...shippableEntries(registry), ...nativeBakedEntries(registry)]) {
    const raw = resolveRaw(config, Mode.Production);
    if (typeof raw === 'string' && raw !== '') add(raw, entry, 'nuisance');
  }
  return shipped;
}

function classify(
  { key, leakImpact }: Declaration,
  value: string | undefined,
  shipped: Map<string, Shipped>
): Needle | NotSwept {
  if (value === undefined || value === '') {
    return { key, reason: 'no value is bound to it in this job' };
  }
  const shippedBy = shipped.get(value);
  if (shippedBy !== undefined && LEAK_SEVERITY[leakImpact] <= LEAK_SEVERITY[shippedBy.leakImpact]) {
    return { key, reason: `its value equals one that ships (${shippedBy.entry})` };
  }
  if (value.length < SWEEP_LENGTH_FLOOR) {
    return {
      key,
      reason: `shorter than ${String(SWEEP_LENGTH_FLOOR)} characters, where a match is coincidence rather than evidence`,
    };
  }
  return { key, value };
}

/** What the sweep looks for in this job, given the values its step binds. */
export function sweepPlan(env: Env, sources: SweepSources = {}): SweepPlan {
  const registry = sources.registry ?? envConfig;
  const { bound, unbound } = partition(sources);
  const shipped = shippedValues(env, bound, registry);
  const needles: Needle[] = [];
  const notSwept: NotSwept[] = [];
  for (const declaration of bound) {
    if (declaration.shipping !== 'not') continue;
    const outcome = classify(declaration, env[declaration.key], shipped);
    if ('value' in outcome) needles.push(outcome);
    else notSwept.push(outcome);
  }
  return {
    needles,
    notSwept: [...notSwept, ...unbound],
    refusals: [...frontendRoutingRefusals(registry), ...nativeRoutingRefusals(registry)],
  };
}
