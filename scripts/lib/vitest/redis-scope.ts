/**
 * The run scope every Redis key a test run touches carries.
 *
 * The harness already hands a test run a different Redis than production —
 * a different logical database, selected by the bearer token the generated
 * env files carry. It does NOT hand two concurrent runs different databases:
 * there is one, one connection pool, and no per-run namespace, so two runs
 * share a keyspace. That is safe only while every key a test touches derives
 * from a random identity, and it is the one contended path whose failure is a
 * wrong answer rather than a crash: a fixed identity, or a global key, reads
 * another run's value and the assertion passes on it.
 *
 * One key forces the scope rather than a convention. Every key builder in the
 * repository takes an identity argument except the global trial daily-spend
 * key, which is built from the calendar day alone — global by design in
 * production, so no test-side identity can make it unique.
 *
 * The scope is applied HERE, at the harness seam that already retargets the
 * worker's `DATABASE_URL`, and not in the product key registry: the registry
 * mints production keys, and a run prefix in it would be a test concern
 * running in production. Nothing in this module is reachable from a product
 * code path — it is imported by the vitest setup file alone, and it wraps
 * `fetch` only when the harness has minted a run token.
 *
 * The transport is where the scope can reach every key, because no single
 * choke point mints them: product code and test code both construct their own
 * `@upstash/redis` clients, and the only thing common to all of them is the
 * HTTP request. The Upstash REST protocol puts the command on the wire as a
 * JSON array (or an array of them for a pipeline), which is what makes the
 * rewrite possible.
 *
 * Which arguments of a command are keys is asked of Redis (`COMMAND INFO` for
 * the shape, `COMMAND GETKEYS` wherever that shape cannot name them — see
 * {@link needsServerNamedKeys}), never written down here: a table of key
 * positions would go silently wrong on the first command nobody thought of,
 * which is the failure mode this module exists to remove.
 *
 * WHAT THE SCOPE DOES NOT REACH: a test run only gets the scope through the
 * vitest setup file that installs it (`setup.ts`), and the workerd projects —
 * every `*.workers.test.ts` file, run from the `vitest.workers.config.ts` of
 * `apps/api`, `packages/db` and `packages/realtime` — name no setup file,
 * because the per-worker database provisioning that setup file does is
 * node-only code workerd cannot execute. So NOTHING a workers test sends to
 * Redis is scoped, and two concurrent runs share every key one of them
 * touches. A workers test that needs a real Redis has to take its identity
 * from a value the test itself minted; today none reaches a live server at
 * all.
 */
import { RUN_TOKEN_VARIABLE } from '@hushbox/db/test-db';

/** Environment variable naming the Redis REST endpoint every client dials. */
const REDIS_ENDPOINT_VARIABLE = 'UPSTASH_REDIS_REST_URL';

/** The harness mints a run token as lowercase hex; anything else is not one. */
const RUN_TOKEN = /^[\da-f]+$/;

/**
 * The scope one run's keys carry. Ends in a separator so a scoped key can
 * never merge into the token, and starts with a marker no product key
 * builder emits, so a scoped key is recognisable in a keyspace dump.
 */
export function runKeyScope(runToken: string): string {
  if (!RUN_TOKEN.test(runToken)) {
    throw new Error(`redis-scope: invalid run token "${runToken}"`);
  }
  return `hbrun-${runToken}:`;
}

/**
 * What Redis says about one command: where its keys sit, whether they move,
 * and whether it addresses the keyspace rather than a key.
 *
 * `addressesKeyspace` is membership in Redis's own `@keyspace` ACL category —
 * the server's answer to "does this command operate on the keyspace", which
 * is what separates `FLUSHALL` and `SCAN` from `PING` and `SCRIPT LOAD`. Both
 * take no key; only the first pair can see or destroy another run.
 */
export interface RedisCommandShape {
  readonly firstKey: number;
  readonly lastKey: number;
  readonly keyStep: number;
  readonly movableKeys: boolean;
  readonly addressesKeyspace: boolean;
}

/** Field offsets in one `COMMAND INFO` row, in the order the server returns them. */
const INFO_FLAGS = 2;
const INFO_FIRST_KEY = 3;
const INFO_LAST_KEY = 4;
const INFO_STEP = 5;
const INFO_ACL_CATEGORIES = 6;

/** The flag Redis sets on a command whose key positions cannot be read off the arity. */
const MOVABLE_KEYS_FLAG = 'movablekeys';

/** The ACL category Redis puts every keyspace-addressing command in. */
const KEYSPACE_CATEGORY = '@keyspace';

function numberAt(row: readonly unknown[], index: number): number {
  const value = row[index];
  if (typeof value !== 'number') {
    throw new TypeError(`redis-scope: COMMAND INFO field ${String(index)} is not a number`);
  }
  return value;
}

function stringsAt(row: readonly unknown[], index: number): string[] {
  const value = row[index];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

/** One `COMMAND INFO` row, decoded to the facts the scoping needs. */
export function decodeCommandShape(raw: unknown): RedisCommandShape {
  if (!Array.isArray(raw)) {
    throw new TypeError(
      'redis-scope: Redis reported an unknown command — a command it cannot describe cannot be scoped to this run'
    );
  }
  return {
    firstKey: numberAt(raw, INFO_FIRST_KEY),
    lastKey: numberAt(raw, INFO_LAST_KEY),
    keyStep: numberAt(raw, INFO_STEP),
    movableKeys: stringsAt(raw, INFO_FLAGS).includes(MOVABLE_KEYS_FLAG),
    addressesKeyspace: stringsAt(raw, INFO_ACL_CATEGORIES).includes(KEYSPACE_CATEGORY),
  };
}

/** The token that introduces a keyspace pattern, in the commands that take one. */
const MATCH_TOKEN = 'match';

/**
 * The index of the pattern a `MATCH` token introduces, or undefined when the
 * command carries none. A pattern is a key pattern only where the command has
 * no key of its own — `HSCAN`'s `MATCH` ranges over one hash's fields — so
 * every caller here reaches this only after the key positions came back empty.
 */
export function matchPatternPosition(argv: readonly unknown[]): number | undefined {
  for (let index = 1; index < argv.length - 1; index += 1) {
    const argument = argv[index];
    if (typeof argument === 'string' && argument.toLowerCase() === MATCH_TOKEN) {
      return index + 1;
    }
  }
  return undefined;
}

/** How one command is brought inside this run's scope. */
type CommandScope =
  | { readonly kind: 'keys'; readonly positions: readonly number[] }
  | { readonly kind: 'pattern'; readonly position: number }
  | { readonly kind: 'passthrough' }
  | { readonly kind: 'unscopable'; readonly reason: string };

/**
 * The argument indices holding a key, for a command whose keys sit at fixed
 * positions. The step needs no zero guard: Redis reports a positive step
 * wherever it reports a first key, and a first key of 0 returns above.
 */
function fixedKeyPositions(shape: RedisCommandShape, argc: number): number[] {
  if (shape.firstKey === 0) return [];
  const last = shape.lastKey < 0 ? argc + shape.lastKey : shape.lastKey;
  const positions: number[] = [];
  for (let index = shape.firstKey; index <= last; index += shape.keyStep) {
    positions.push(index);
  }
  return positions;
}

/**
 * Whether this command's keys have to be asked of the server rather than read
 * off its `COMMAND INFO` row.
 *
 * Two command shapes report `first_key` 0 while carrying a key, and they are
 * one fact: the row's key fields are the LEGACY answer, and Redis leaves them
 * at 0 wherever the modern key specs cannot be flattened into a first/last/step
 * triple. That covers the `EVAL` family, which says so with the `movablekeys`
 * flag — and it also covers every container command, whose key sits under a
 * subcommand (`OBJECT ENCODING k`, `MEMORY USAGE k`, `XINFO STREAM s`,
 * `XGROUP CREATE s g $`), which says so with nothing at all: no flag, and ACL
 * categories that do not include `@keyspace`. Read off the row alone, those
 * classify as "no keys, addresses nothing" and their key reaches the server
 * bare — the silent wrong answer this module exists to remove, on exactly the
 * command nobody thought of. Asked, the server names the key.
 */
export function needsServerNamedKeys(shape: RedisCommandShape): boolean {
  return shape.movableKeys || (shape.firstKey === 0 && !shape.addressesKeyspace);
}

/**
 * The positions of the keys the server named, matched back onto the argument
 * list left to right: `COMMAND GETKEYS` answers with key VALUES, and the scope
 * has to be applied to positions.
 */
function namedKeyPositions(argv: readonly unknown[], keys: readonly string[]): number[] {
  const positions: number[] = [];
  let searchFrom = 1;
  for (const key of keys) {
    const index = argv.indexOf(key, searchFrom);
    if (index === -1) {
      throw new Error(
        `redis-scope: Redis named "${key}" as a key of this command, but it is not in the command's arguments`
      );
    }
    positions.push(index);
    searchFrom = index + 1;
  }
  return positions;
}

/**
 * How this command is scoped.
 *
 * A command with keys is scoped at its keys. A command with none either
 * addresses the keyspace — scopable only through a pattern, refused outright
 * without one, because nothing else can narrow it to this run — or addresses
 * no keyspace at all (a connection or scripting command), which nothing about
 * this run's data depends on and which therefore passes through.
 *
 * `serverNamedKeys` carries the server's own answer, and is present exactly
 * when {@link needsServerNamedKeys} said to ask: an empty list there is the
 * server saying this command has no key arguments, which is a different fact
 * from the row's key fields being 0 and is the one that decides passthrough.
 */
export function planCommandScope(
  argv: readonly unknown[],
  shape: RedisCommandShape,
  serverNamedKeys?: readonly string[]
): CommandScope {
  const positions =
    serverNamedKeys === undefined
      ? fixedKeyPositions(shape, argv.length)
      : namedKeyPositions(argv, serverNamedKeys);
  if (positions.length > 0) return { kind: 'keys', positions };
  if (!shape.addressesKeyspace) return { kind: 'passthrough' };
  const pattern = matchPatternPosition(argv);
  if (pattern !== undefined) return { kind: 'pattern', position: pattern };
  return {
    kind: 'unscopable',
    reason:
      'it addresses the whole keyspace and names no pattern, so it would read or destroy every concurrent run',
  };
}

/** The command's argument list with this run's scope applied where the plan says. */
export function applyCommandScope(
  argv: readonly unknown[],
  plan: CommandScope,
  scope: string
): unknown[] {
  if (plan.kind === 'passthrough' || plan.kind === 'unscopable') return [...argv];
  const positions = plan.kind === 'keys' ? plan.positions : [plan.position];
  const scoped = [...argv];
  for (const position of positions) {
    const argument = scoped[position];
    if (typeof argument !== 'string') {
      throw new TypeError(
        `redis-scope: argument ${String(position)} of "${String(argv[0])}" is a key but is not a string`
      );
    }
    scoped[position] = scope + argument;
  }
  return scoped;
}

/** Identity coding, for a response whose strings are on the wire as written. */
const asWritten = (text: string): string => text;

/**
 * The scope removed from every string in a scoped walk's result.
 *
 * Applied only to the result of a command whose PATTERN this run scoped — the
 * commands that return keys — so a value is never rewritten. Any string
 * carrying the scope there is a key this module prefixed on the way out: the
 * scope holds the run token, which exists nowhere else.
 */
export function stripScope(
  value: unknown,
  scope: string,
  decode: (text: string) => string = asWritten,
  encode: (text: string) => string = asWritten
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripScope(entry, scope, decode, encode));
  }
  if (typeof value !== 'string') return value;
  const decoded = decode(value);
  return decoded.startsWith(scope) ? encode(decoded.slice(scope.length)) : value;
}

/** One command run on the same connection the intercepted request used. */
type IssueCommand = (argv: readonly unknown[]) => Promise<unknown>;

/** A command described: its shape, and the keys the server named when it was asked. */
interface CommandDescription {
  readonly shape: RedisCommandShape;
  readonly serverNamedKeys?: readonly string[];
}

/** Asks Redis to describe a command, remembering the answers that cannot change. */
type CommandDescriber = (
  argv: readonly unknown[],
  issue: IssueCommand
) => Promise<CommandDescription>;

/**
 * The server's own answer that a command carries no key arguments at all.
 *
 * `COMMAND GETKEYS` has two ways of saying "no keys" and they mean opposite
 * things here: this error, which is the command carrying none in any argument
 * list, and an empty list, which is these arguments naming none. Only the
 * error can be read as a fact about the command, and reading it is what keeps
 * `PING` working; every other failure is a command this module could not
 * describe, and it is raised rather than guessed at.
 */
const NO_KEY_ARGUMENTS = /no key arguments/i;

/** The keys the server names for this exact argument list, or none if it says there are none. */
async function serverNamedKeysOf(
  argv: readonly unknown[],
  issue: IssueCommand
): Promise<readonly string[]> {
  let named: unknown;
  try {
    named = await issue(['COMMAND', 'GETKEYS', ...argv]);
  } catch (error) {
    if (error instanceof Error && NO_KEY_ARGUMENTS.test(error.message)) return [];
    throw error;
  }
  return Array.isArray(named) ? named.map(String) : [];
}

/**
 * A describer with its own memory of the shapes it has seen.
 *
 * A command's shape is a property of the server and never changes, so it is
 * asked once per name. The KEYS are a property of the ARGUMENTS — a container
 * command's key hangs off its subcommand, and `EVAL`'s off its key count — so
 * those are asked every time the shape says they have to be asked at all.
 * Caching them by name is the table of guesses this module refuses to keep:
 * `OBJECT HELP` and `OBJECT ENCODING k` are one name and different answers.
 */
export function createCommandDescriber(): CommandDescriber {
  const shapes = new Map<string, RedisCommandShape>();
  return async (argv, issue) => {
    const name = String(argv[0]).toLowerCase();
    let shape = shapes.get(name);
    if (shape === undefined) {
      const rows = await issue(['COMMAND', 'INFO', name]);
      shape = decodeCommandShape(Array.isArray(rows) ? rows[0] : undefined);
      shapes.set(name, shape);
    }
    if (!needsServerNamedKeys(shape)) return { shape };
    return { shape, serverNamedKeys: await serverNamedKeysOf(argv, issue) };
  };
}

/** What the scoped fetch needs to do its work. */
interface RunScopedFetchDeps {
  /** The fetch every scoped request is finally made with. */
  readonly fetch: typeof globalThis.fetch;
  /** The Redis REST endpoint, as the env registry spells it. */
  readonly endpoint: string;
  /** This run's key scope. */
  readonly scope: string;
  /** How a command is described; injected so the unit cases reach no server. */
  readonly describe: CommandDescriber;
}

/** The header the Upstash client sets when it wants its response encoded. */
const ENCODING_HEADER = 'upstash-encoding';
const BASE64_ENCODING = 'base64';

function decodeBase64(text: string): string {
  return Buffer.from(text, 'base64').toString('binary');
}

function encodeBase64(text: string): string {
  return Buffer.from(text, 'binary').toString('base64');
}

/** Whichever of the three forms fetch takes its target in. */
type FetchTarget = string | URL | Request;

/** The request's URL, from whichever of the three forms fetch was called with. */
function requestUrl(input: FetchTarget): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * A header's value, from wherever fetch's two arguments carry it: an init's
 * headers in any of the shapes fetch accepts, and otherwise the `Request` the
 * call was made with. The init wins where both carry the name, which is the
 * order fetch itself resolves them in.
 */
function headerValue(
  input: FetchTarget,
  init: RequestInit | undefined,
  name: string
): string | undefined {
  const headers = init?.headers;
  const fromInit = headers === undefined ? null : new Headers(headers).get(name);
  if (fromInit !== null) return fromInit;
  return input instanceof Request ? (input.headers.get(name) ?? undefined) : undefined;
}

/**
 * A body carried in a shape this wrapper cannot read as text — bytes, a stream,
 * a form. It stands for the body rather than for its absence, because the two
 * earn opposite answers: a request carrying none passes through, and one
 * carrying a body nothing here can read is refused.
 */
const UNREADABLE_BODY = Symbol('redis-scope: a body this wrapper cannot read as text');

/**
 * The request's body as text, from whichever of fetch's two arguments carries
 * it. A `Request` may hold the body instead of the init, and reading only the
 * init classified that call as bodyless — so its command went to the server
 * with its key bare, silently outside this run's scope. The body is read off a
 * CLONE, leaving the original usable by the passthrough that follows when the
 * body turns out not to be a command.
 *
 * A null body on the init is the init carrying none rather than an empty one,
 * so the `Request` is read in that case — the resolution fetch itself makes,
 * which is what keeps this reading of the two arguments the same as the one
 * the inner fetch goes on to apply.
 */
async function requestBodyText(
  input: FetchTarget,
  init: RequestInit | undefined
): Promise<string | undefined | typeof UNREADABLE_BODY> {
  const initBody = init?.body;
  if (typeof initBody === 'string') return initBody;
  if (initBody !== undefined && initBody !== null) return UNREADABLE_BODY;
  if (!(input instanceof Request) || input.body === null) return undefined;
  return input.clone().text();
}

/** One request's commands, and whether the endpoint was given a batch of them. */
interface RequestCommands {
  readonly commands: unknown[][];
  readonly batched: boolean;
}

/**
 * The commands a Redis request carries, or undefined for a Redis request this
 * wrapper has nothing to do with: no body, a body that is not JSON, or JSON
 * that is not a command. Each of those passes through untouched.
 */
function requestCommands(body: string | undefined): RequestCommands | undefined {
  if (body === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  if (!Array.isArray(parsed[0])) return { commands: [parsed], batched: false };
  return parsed.every((entry) => Array.isArray(entry))
    ? { commands: parsed as unknown[][], batched: true }
    : undefined;
}

/** The per-command results in a response body, in the order the commands were sent. */
function resultsIn(body: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(body)) {
    return body.every((entry) => typeof entry === 'object' && entry !== null)
      ? (body as Record<string, unknown>[])
      : undefined;
  }
  if (typeof body === 'object' && body !== null) return [body as Record<string, unknown>];
  return undefined;
}

/** One request's commands scoped, with the plan each was scoped under. */
interface ScopedCommands {
  readonly plans: readonly CommandScope[];
  readonly scoped: unknown[][];
}

/**
 * Every command of one request brought inside the scope. A command the scope
 * cannot reach stops the request here rather than reaching the server, which
 * is the whole difference between a loud refusal and another run's answer.
 */
async function scopeCommands(
  commands: readonly unknown[][],
  scope: string,
  describe: CommandDescriber,
  issue: IssueCommand
): Promise<ScopedCommands> {
  const plans: CommandScope[] = [];
  const scoped: unknown[][] = [];
  for (const argv of commands) {
    const described = await describe(argv, issue);
    const plan = planCommandScope(argv, described.shape, described.serverNamedKeys);
    if (plan.kind === 'unscopable') {
      throw new Error(
        `redis-scope: a test run may not issue "${String(argv[0])}" — ${plan.reason}. ` +
          'Address a key instead, or narrow the walk with a MATCH pattern.'
      );
    }
    plans.push(plan);
    scoped.push(applyCommandScope(argv, plan, scope));
  }
  return { plans, scoped };
}

/**
 * The response with this run's scope taken back off the keys a scoped walk
 * returned. Only a walk's result is touched — a command scoped at its keys
 * returns values, and a value is never rewritten.
 */
async function restoreWalkedKeys(
  response: Response,
  plans: readonly CommandScope[],
  scope: string,
  encoded: boolean
): Promise<Response> {
  const body = (await response.clone().json()) as unknown;
  const results = resultsIn(body);
  if (results === undefined) return response;
  const restored = results.map((entry, index) =>
    plans[index]?.kind === 'pattern' && 'result' in entry
      ? {
          ...entry,
          result: encoded
            ? stripScope(entry['result'], scope, decodeBase64, encodeBase64)
            : stripScope(entry['result'], scope),
        }
      : entry
  );
  return Response.json(Array.isArray(body) ? restored : restored[0], {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * A fetch that brings every Redis command this run issues inside its own
 * scope, and takes the scope back off the keys a scoped walk returns.
 *
 * A request to any other host, and a Redis request carrying no command, are
 * passed to the inner fetch untouched — the inner fetch is the network guard,
 * so nothing this wrapper does weakens it. A Redis request whose body this
 * wrapper cannot read is refused instead, on the same ground as a command the
 * scope cannot reach: what cannot be scoped does not go to the server.
 */
export function createRunScopedFetch(deps: RunScopedFetchDeps): typeof globalThis.fetch {
  /**
   * A describing command on the SAME connection the intercepted request used:
   * the bearer token selects the logical database, so asking on any other
   * connection would describe a different server and, in this stack, would not
   * be authorized at all.
   */
  const issueOn =
    (authorization: string | undefined): IssueCommand =>
    async (argv) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (authorization !== undefined) headers['authorization'] = authorization;
      const response = await deps.fetch(deps.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(argv),
      });
      const body = (await response.json()) as { result?: unknown; error?: string };
      if (body.error !== undefined) {
        throw new Error(`redis-scope: ${String(argv[1])} ${String(argv[2])} failed: ${body.error}`);
      }
      return body.result;
    };

  return async function runScopedFetch(input, init) {
    const target = input as FetchTarget;
    if (!requestUrl(target).startsWith(deps.endpoint)) return deps.fetch(input, init);
    const body = await requestBodyText(target, init);
    if (body === UNREADABLE_BODY) {
      throw new TypeError(
        'redis-scope: a test run may not send a Redis request whose body is not a string — ' +
          'this wrapper cannot read it, so any key it carries would reach the server bare and ' +
          "outside this run's scope. Send the command as a JSON string body."
      );
    }
    const request_ = requestCommands(body);
    if (request_ === undefined) return deps.fetch(input, init);

    const { plans, scoped } = await scopeCommands(
      request_.commands,
      deps.scope,
      deps.describe,
      issueOn(headerValue(target, init, 'authorization'))
    );
    const response = await deps.fetch(input, {
      ...init,
      body: JSON.stringify(request_.batched ? scoped : scoped[0]),
    });
    if (!plans.some((plan) => plan.kind === 'pattern')) return response;
    return restoreWalkedKeys(
      response,
      plans,
      deps.scope,
      headerValue(target, init, ENCODING_HEADER) === BASE64_ENCODING
    );
  };
}

/**
 * Installs the run scope on the global fetch, when and only when this process
 * is a test run: the harness mints the run token, and nothing outside it sets
 * one. A process with no token — every production and every non-vitest path —
 * leaves fetch exactly as it found it.
 */
export function installRedisRunScope(
  env: NodeJS.ProcessEnv,
  globalScope: { fetch: typeof globalThis.fetch }
): void {
  const runToken = env[RUN_TOKEN_VARIABLE];
  const endpoint = env[REDIS_ENDPOINT_VARIABLE];
  if (runToken === undefined || runToken === '') return;
  if (endpoint === undefined || endpoint === '') return;
  globalScope.fetch = createRunScopedFetch({
    fetch: globalScope.fetch.bind(globalScope),
    endpoint: endpoint.replace(/\/$/, ''),
    scope: runKeyScope(runToken),
    describe: createCommandDescriber(),
  });
}
