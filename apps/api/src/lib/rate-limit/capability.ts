import { okAsync } from '../result/index.js';
import { classDefaultFor } from './class-default.js';
import { consumeLayers } from './consume.js';
import type { Redis } from '@upstash/redis';
import type { DomainError } from '../errors/index.js';
import type { ResultAsync } from '../result/index.js';
import type { LayeredRateLimitDecision, RateLimitDecision, RateLimitLayer } from './consume.js';
import type { RouteClass } from '../context/index.js';
import type { RateLimitDefinition } from './definition.js';
import type { EdgeIdentity, FailurePosture, PostureIdentity, RoutePosture } from './posture.js';
import type { RouterRoute } from 'hono/types';

/**
 * # Bound counting capabilities
 *
 * What crosses a slice's perimeter when the slice declares how its routes are
 * bounded: a capability closed over the registry entry, never the entry. Key
 * material, caps, windows and `clear` stay unreachable from the published
 * value — a closure's captures have no reflection in JavaScript, so this is a
 * property of the language rather than of a lint rule.
 *
 * The residue, stated rather than dressed: INVOCATION does not close. Any file
 * in this package can import a capability and spend its windows. Severing that
 * needs a runtime boundary, which `docs/DECISIONS.md` declines for internal
 * seams.
 */

declare const COUNTED_IN_FLOW: unique symbol;

/**
 * A reference to an entry the OWNING SLICE'S OWN DOMAIN FLOW spends. Nothing
 * invokes one — it carries no callable at all — because its entire job is to
 * be a compiler-checked citation that some route's bound exists. It is named
 * apart from {@link CountAtEdge} for that reason: the asymmetry between a
 * callable edge capability and an inert flow reference is the design, not an
 * oversight to be tidied away.
 */
export interface CountedInFlow {
  readonly [COUNTED_IN_FLOW]: true;
}

/**
 * Memoized per entry so that binding one entry twice yields one reference, and
 * a colocated test can assert that a route's declaration cites the very object
 * its domain consumes. It keys on the entry, which is a module singleton, and
 * holds nothing derived from a request — so it is per-isolate memoization, not
 * the persistent in-memory state the serverless doctrine bans.
 *
 * What such a test can prove is bounded: entries that ARE the same object
 * (several step-up gates share one lockout) bind to one reference, so the
 * assertion reads "a counter is cited", never "this gate's counter is cited".
 */
const FLOW_REFERENCES = new WeakMap<RateLimitDefinition, CountedInFlow>();

export function countedInFlow(definition: RateLimitDefinition): CountedInFlow {
  const existing = FLOW_REFERENCES.get(definition);
  if (existing !== undefined) return existing;
  const reference = Object.freeze({}) as CountedInFlow;
  FLOW_REFERENCES.set(definition, reference);
  return reference;
}

/**
 * One layer of one route's bound: which caller identity it counts, where the
 * counting happens, and the entry it counts on. A route's whole posture is
 * declared as a list of these and nothing else — {@link bindRoutePosture}
 * derives both the identity list and the capabilities from it, so there is no
 * second declaration for it to fall out of step with.
 *
 * Discriminated on `countedAt`, which is what narrows the identity vocabulary
 * per arm: the pipeline stage resolves an edge layer's identity, so an edge
 * layer may name only what the stage can derive from a request, while a flow
 * layer is resolved by the owning slice's own domain and may name the wider
 * set. Written as a union rather than as one shape over the whole vocabulary
 * so that an unresolvable identity on an edge layer FAILS TO COMPILE at the
 * declaration — the alternative rests entirely on the stage's resolver map
 * being total, which is a guarantee one file away from the declaration that
 * needs it.
 */
type PostureLayer =
  | {
      readonly identity: EdgeIdentity;
      readonly countedAt: 'edge';
      readonly definition: RateLimitDefinition;
    }
  | {
      readonly identity: PostureIdentity;
      readonly countedAt: 'flow';
      readonly definition: RateLimitDefinition;
    };

/** The arm of {@link PostureLayer} the pipeline stage spends. */
type EdgePostureLayer = Extract<PostureLayer, { countedAt: 'edge' }>;

/**
 * The pipeline-counted layers of ONE route, as a single all-or-nothing call:
 * `consumeLayers` needs every layer's key, cap and window in one atomic script
 * call, so a capability per layer would be one round trip per layer and would
 * reinstate the stacked-mount defect layering exists to remove.
 *
 * `count` takes one identity per `keyedBy` entry, positionally, with `null`
 * for a layer the caller's identity is deliberately not counted under. It
 * answers a {@link RateLimitDecision} rather than the layered one: once layers
 * can be skipped, the layered decision's position no longer addresses anything
 * the caller declared.
 */
export interface CountAtEdge {
  readonly keyedBy: readonly [EdgeIdentity, ...EdgeIdentity[]];
  readonly count: (
    redis: Redis,
    ids: readonly (string | null)[]
  ) => ResultAsync<RateLimitDecision, DomainError>;
}

/**
 * A `named` posture that carries its bounds. `keyedBy` names every layer's
 * identity wherever the counting happens, matching what the posture map has
 * always recorded; `countAtEdge` is present exactly when some layer is counted
 * by the pipeline; `failure` is the route's own declaration, carried across
 * the perimeter unchanged so the pipeline reads it rather than deriving one.
 */
export interface NamedRoutePosture {
  readonly kind: 'named';
  readonly keyedBy: readonly [PostureIdentity, ...PostureIdentity[]];
  readonly failure: FailurePosture;
  readonly countAtEdge: CountAtEdge | undefined;
  readonly countedInFlow: readonly CountedInFlow[];
}

/**
 * What a slice's posture fragment declares per route. Only the `named` arm
 * widens: the other two are read off {@link RoutePosture} rather than
 * restated, so an exemption class added there reaches every fragment without
 * a second list to update.
 */
export type CarriedRoutePosture = NamedRoutePosture | Exclude<RoutePosture, { kind: 'named' }>;

const UNCOUNTED = okAsync<RateLimitDecision, DomainError>({ allowed: true, count: 0 });

function withoutLayerPosition(decision: LayeredRateLimitDecision): RateLimitDecision {
  return decision.allowed
    ? decision
    : {
        allowed: false,
        count: decision.count,
        retryAfterSeconds: decision.retryAfterSeconds,
      };
}

function identitiesOf<Identity extends PostureIdentity>(
  first: { readonly identity: Identity },
  rest: readonly { readonly identity: Identity }[]
): readonly [Identity, ...Identity[]] {
  return [first.identity, ...rest.map((layer) => layer.identity)];
}

function bindEdge(first: EdgePostureLayer, rest: readonly EdgePostureLayer[]): CountAtEdge {
  const edgeLayers: readonly EdgePostureLayer[] = [first, ...rest];
  return {
    keyedBy: identitiesOf(first, rest),
    count: (redis, ids) => {
      if (ids.length !== edgeLayers.length) {
        throw new Error(
          'rate-limit capability: one identity per keyedBy entry is required — the caller ' +
            'resolved a list the route never declared.'
        );
      }
      const counted: RateLimitLayer[] = [];
      for (const [index, layer] of edgeLayers.entries()) {
        const id = ids[index] ?? null;
        if (id !== null) counted.push({ definition: layer.definition, id });
      }
      if (counted.length === 0) return UNCOUNTED;
      return consumeLayers(redis, counted).map((decision) => withoutLayerPosition(decision));
    },
  };
}

/**
 * Binds ONE ROUTE's class default into the same edge bound a route's own layers
 * produce, so the pipeline spends a class default through the counting path it
 * already spends a named route's through. Its answer is a {@link CountAtEdge}
 * rather than the optional one {@link NamedRoutePosture} carries: a class
 * default is one always-counted layer by construction, and typing it as
 * possibly-absent would hand its caller an arm that cannot happen.
 *
 * It takes the route rather than a bound entry, so a class default cannot be
 * bound without one: the per-route counter `classDefaultFor` derives is the
 * only counter a `default` declaration can reach from here. The route is a
 * method and a path together — the pair every route-keyed map in this Worker is
 * keyed by — so no caller can bind a counter shared across a path's methods.
 */
export function bindClassDefault(
  routeClass: RouteClass,
  route: Pick<RouterRoute, 'method' | 'path'>
): CountAtEdge {
  const { identity, definition } = classDefaultFor(routeClass, route);
  return bindEdge({ identity, countedAt: 'edge', definition }, []);
}

/**
 * What one `named` route declares: its two dimensions, written apart. `layers`
 * is the limit — the entries that bound it and where each is counted;
 * `failure` is what an unspendable bound earns, and neither is derivable from
 * the other.
 */
interface RoutePostureDeclaration {
  readonly failure: FailurePosture;
  readonly layers: readonly [PostureLayer, ...PostureLayer[]];
}

/**
 * Binds one route's declaration into its posture. Every published field but
 * the failure posture is computed from the one layer list, so a reader has
 * nothing to keep in step: adding a layer moves the identity list, the edge
 * call's arity and the flow citations together, and reordering the list
 * reorders all three.
 *
 * The one constraint between the two dimensions, and what it rules out. The
 * pipeline is the single reader of `failure`, and it spends a route's EDGE
 * layers alone; a flow layer is spent by the owning slice's domain, which
 * refuses an unspendable counter on its own terms and reads no posture. So
 * `open` is honourable exactly for a route counted only at the edge. On a
 * route with no edge layer the pipeline spends nothing, and the declaration is
 * inert. On a MIXED route it would hold for half the request — the edge half
 * admits uncounted while the flow half still refuses — which is a declaration
 * the system cannot keep rather than a bound it fails to apply. Both are
 * refused here, at composition, rather than left to be discovered as a route
 * that answers 503 while its posture says otherwise. `closed` is honourable in
 * every arrangement, since both halves refuse alike.
 */
export function bindRoutePosture(declaration: RoutePostureDeclaration): NamedRoutePosture {
  const { failure, layers } = declaration;
  const [first, ...rest] = layers;
  const [firstEdge, ...restEdge] = layers.filter((layer) => layer.countedAt === 'edge');
  if (failure === 'open' && layers.some((layer) => layer.countedAt === 'flow')) {
    throw new Error(
      'rate-limit posture: an open failure posture requires every layer counted at the edge — ' +
        'the pipeline is what admits an unspendable bound and it spends the edge layers only, ' +
        'so a layer counted in its own slice flow leaves the declaration unhonoured for the ' +
        'part of the route the pipeline never reaches.'
    );
  }
  return {
    kind: 'named',
    keyedBy: identitiesOf(first, rest),
    failure,
    countAtEdge: firstEdge === undefined ? undefined : bindEdge(firstEdge, restEdge),
    countedInFlow: layers
      .filter((layer) => layer.countedAt === 'flow')
      .map((layer) => countedInFlow(layer.definition)),
  };
}
