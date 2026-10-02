import { randomBytes } from 'node:crypto';

/**
 * Naming, URL rewriting and SQL for the per-vitest-worker Postgres databases,
 * and the naming of the other resources a test run owns.
 *
 * Every vitest worker slot runs against its own clone of a migrated+seeded
 * template so concurrent test files — and concurrent whole runs — cannot see
 * each other's rows. It is published as its own subpath and is deliberately
 * dependency-free — `scripts/with-env.ts` imports it on every developer command
 * and `scripts/lib/vitest/setup.ts` loads it in every worker, so a dependency
 * added here is paid on both. It lives in this package rather than beside its
 * callers because the script tree and `apps/api` both already depend on this
 * package, and the reverse edge would close a cycle. The driver-facing half
 * lives in `scripts/lib/test-run/test-db-provision.ts`.
 */

/** Every per-run database starts with this; the debris sweep drops by it. */
export const TEST_DATABASE_PREFIX = 'hb_t_';

/**
 * The migrated+seeded clone source. Named outside {@link TEST_DATABASE_PREFIX}
 * on purpose: the sweep drops everything under that prefix by age, and the
 * template must survive it.
 */
export const TEMPLATE_DATABASE = 'hb_tpl';

/**
 * The family for a database whose whole life under its name sits inside the one
 * operation that minted it, so nothing outside that operation ever depends on
 * the name. Two names it must avoid: {@link TEST_DATABASE_PREFIX}, because a
 * name under that prefix is claimed under its run's whole per-worker prefix
 * while a staged one is claimed under its own whole name, and
 * {@link TEMPLATE_DATABASE} as a substring, because the scratch-template proof
 * redirects statements by replacing that spelling and would rewrite the inside
 * of every staged name it produced.
 */
export const STAGE_DATABASE_PREFIX = 'hb_stage_';

/**
 * Sweep age for the one debris path left that reads a clock and does not decide
 * liveness: the pre-registry migration {@link preRegistryDatabaseNames}
 * describes. 60 minutes is roughly eight times the full suite's wall time.
 */
export const STALE_DATABASE_AGE_MS = 60 * 60 * 1000;

/** Creation instant lives in the database comment: `pg_database` records no timestamp. */
export const CREATED_COMMENT_PREFIX = 'hushbox-test-db created=';

/**
 * Precedes the fingerprint the template was built from, in its comment: one
 * digest over the migrations and what the seed imports.
 */
export const TEMPLATE_COMMENT_PREFIX = 'hushbox-test-template migrations+seed-inputs=';

/**
 * Set by the harness to retarget a `with-env.ts` child at one database. Nothing
 * else can: the env files are loaded with `override: true`, so a pre-set
 * `DATABASE_URL` is clobbered before the child command ever sees it.
 */
export const TEST_DATABASE_VARIABLE = 'HB_TEST_DB';

/** Environment variable carrying the run identity into forked workers. */
export const RUN_TOKEN_VARIABLE = 'HB_TEST_RUN_TOKEN';

/**
 * Environment variable carrying, into forked workers, the seed-input digest the
 * run's template was checked against when the run was prepared.
 */
export const SEED_INPUTS_DIGEST_VARIABLE = 'HB_TEST_SEED_INPUTS_DIGEST';

/**
 * Where {@link applyTestDatabaseName} keeps the `DATABASE_URL` it displaced, so
 * a writer whose row has to outlive the worker's clone can still reach the
 * database the clone was made from. Read through {@link evidenceDatabaseUrl}.
 */
export const BASE_DATABASE_URL_VARIABLE = 'HB_BASE_DATABASE_URL';

/** Vitest gives every worker one; its presence is how this file knows a retarget was due. */
const WORKER_SLOT_VARIABLE = 'VITEST_POOL_ID';

/** Every scratch bucket a test run creates starts with this. */
export const SCRATCH_BUCKET_PREFIX = 'hushbox-scratch-';

/** Separates a run's token from its worker slot in a database name, both ways. */
const SLOT_INFIX = '_w';

const RUN_TOKEN_REGEX = /^[\da-z]+$/;
const SLOT_REGEX = /^\d+$/;
const IDENTIFIER_REGEX = /^[a-z_][\da-z_]*$/;

/** An object store caps a bucket name here, and the local one enforces it. */
const MAX_BUCKET_NAME_LENGTH = 63;

/**
 * Postgres caps an identifier here and truncates a longer one with a notice
 * rather than refusing it, so a name that overruns is created under a spelling
 * nothing can read a run out of. Checked where a name is minted for that
 * reason: the server answers a truncation the same way it answers a fit.
 */
const MAX_DATABASE_NAME_LENGTH = 63;

/** Bytes of randomness that keep one run's staging names apart. */
const STAGE_DATABASE_ID_BYTES = 8;

/** Separates a run's token from the per-build suffix in a staging name, both ways. */
const STAGE_INFIX = '_';

/** Bytes of randomness in the suffix that keeps one run's buckets apart. */
const SCRATCH_BUCKET_ID_BYTES = 7;

/**
 * The groups a claim-registry run id is written in, and the separator between
 * them. A run token is that id with the separators taken out, because a
 * database identifier may not hold one; putting them back is what lets a name
 * on disk answer which run made it with no record of that run left anywhere.
 */
const RUN_ID_GROUPS = [8, 4, 4, 4, 12];
const RUN_ID_SEPARATOR = '-';

/** Postgres connection strings the harness retargets at the worker's own database. */
const DATABASE_URL_VARIABLES = [
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'ADMIN_SQL_PANEL_DATABASE_URL',
] as const;

/**
 * The token every resource of the run holding `runId` is named under: the run's
 * own id, in the one spelling a database identifier and a bucket name can both
 * carry.
 *
 * A minted-per-run token of its own is what this replaces, and the reason is
 * attribution rather than uniqueness. The link from such a token to its run
 * lived only in the run's registry record, and a run that ends the way it meant
 * to removes that record — so a resource its workers left standing named a run
 * nothing on disk could identify, and no pass could ever do more than report it.
 * A name carrying the run id is attributable with no record at all.
 *
 * Refuses an id it cannot name back, so nothing is ever created under a name
 * this module could not attribute afterwards. The claim registry
 * (`scripts/lib/claims/registry.ts`) is what mints the ids this accepts.
 */
export function runTokenFor(runId: string): string {
  const runToken = runId.replaceAll(RUN_ID_SEPARATOR, '');
  if (runIdFromToken(runToken) !== runId) {
    throw new Error(`test-db: "${runId}" is not a run id a resource name can carry`);
  }
  return runToken;
}

/**
 * The run a token names, or undefined for a token no run id could have
 * produced — every token minted before they carried one, and anything else
 * that reached a name this module reads. Such a token names no run, which is
 * the answer that leaves the resource reported and standing.
 */
export function runIdFromToken(runToken: string): string | undefined {
  const width = RUN_ID_GROUPS.reduce((total, group) => total + group, 0);
  if (runToken.length !== width || !/^[\da-f]+$/.test(runToken)) return undefined;
  const groups: string[] = [];
  let at = 0;
  for (const group of RUN_ID_GROUPS) {
    groups.push(runToken.slice(at, at + group));
    at += group;
  }
  return groups.join(RUN_ID_SEPARATOR);
}

/**
 * The suffix that keeps one run's scratch buckets apart, sized to what the
 * name has left once the prefix and the run token have taken theirs. Minted
 * here rather than by each caller so the budget {@link scratchBucketName}
 * enforces has one place that is known to fit it.
 */
export function mintScratchBucketId(): string {
  return randomBytes(SCRATCH_BUCKET_ID_BYTES).toString('hex');
}

/** Common prefix of every slot database belonging to one run. */
export function runDatabasePrefix(runToken: string): string {
  if (!RUN_TOKEN_REGEX.test(runToken)) {
    throw new Error(`test-db: invalid run token "${runToken}"`);
  }
  return `${TEST_DATABASE_PREFIX}${runToken}${SLOT_INFIX}`;
}

/**
 * The run token a per-worker database's name carries, or undefined for a name
 * this module never minted.
 *
 * Attribution reads the name because the name is the only part of a database
 * that exists from the instant the database does: `CREATE DATABASE` and
 * `COMMENT ON DATABASE` are two statements, so a database another run is
 * creating right now carries no comment at all for the moment between them,
 * and anything reading its comment sees a database that belongs to nobody.
 */
export function testDatabaseRunToken(datname: string): string | undefined {
  if (!datname.startsWith(TEST_DATABASE_PREFIX)) return undefined;
  const [token, slot, ...rest] = datname.slice(TEST_DATABASE_PREFIX.length).split(SLOT_INFIX);
  if (token === undefined || slot === undefined || rest.length > 0) return undefined;
  if (!RUN_TOKEN_REGEX.test(token) || !SLOT_REGEX.test(slot)) return undefined;
  return token;
}

/** Which family a database name belongs to, and the id its claim is keyed by. */
interface DatabaseClaim {
  readonly family: 'per-worker' | 'staging';
  readonly id: string;
  /**
   * The run the name itself says made this database, for the attribution that
   * outlives the run's record. Undefined for a name minted before names in its
   * family carried one.
   */
  readonly runId: string | undefined;
}

/**
 * How a claim on a database is keyed, which its own name decides.
 *
 * A per-worker database names its run, and the run records the prefix that name
 * gives it, so one claim covers every worker's database. A staging template is
 * minted per build and never reissued, so the build records the whole name, and
 * those are the only two families anything mints under these names. Both carry
 * their run in the name as well, which is what attributes one whose run ended
 * and took its record with it.
 *
 * Everything that asks either question asks it here. The sweep that drops on
 * the ownership answer and the audit that reports on it must key their lookups
 * the same way, and a second spelling of this mapping is a live build's
 * database reported as unowned.
 */
export function databaseClaim(datname: string): DatabaseClaim {
  const runToken = testDatabaseRunToken(datname);
  if (runToken !== undefined) {
    return {
      family: 'per-worker',
      id: runDatabasePrefix(runToken),
      runId: runIdFromToken(runToken),
    };
  }
  const stageToken = stageDatabaseRunToken(datname);
  return {
    family: 'staging',
    id: datname,
    runId: stageToken === undefined ? undefined : runIdFromToken(stageToken),
  };
}

/** The database for one vitest worker slot (`VITEST_POOL_ID`, bounded and recycled). */
export function slotDatabaseName(runToken: string, slot: string): string {
  if (!SLOT_REGEX.test(slot)) {
    throw new Error(`test-db: invalid worker slot "${slot}"`);
  }
  return `${runDatabasePrefix(runToken)}${slot}`;
}

/** Same server, same credentials, different database. */
export function withDatabaseName(connectionString: string, databaseName: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`test-db: "${connectionString}" is not a valid connection string`);
  }
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * Retargets every Postgres URL in `env` at `databaseName`, in place. Shared by
 * `with-env.ts` (template build) and the vitest setup file (worker slots) so the
 * two can never disagree about which variables carry a database.
 *
 * It also preserves the `DATABASE_URL` it is about to destroy, because this is
 * the only place that value still exists: a writer whose row must outlive the
 * clone has no other way back to the database the clone came from, and
 * rebuilding the base name instead of keeping it would be a second copy of the
 * naming this function owns. The capture is taken only when unset, so what it
 * preserves is always the `DATABASE_URL` the environment arrived with and never
 * one this function wrote: a retarget applied over an already-retargeted
 * environment leaves the true base standing.
 */
export function applyTestDatabaseName(env: NodeJS.ProcessEnv, databaseName: string): void {
  const base = env['DATABASE_URL'];
  const captured = env[BASE_DATABASE_URL_VARIABLE];
  if ((captured === undefined || captured === '') && base !== undefined && base !== '') {
    env[BASE_DATABASE_URL_VARIABLE] = base;
  }
  for (const variable of DATABASE_URL_VARIABLES) {
    const current = env[variable];
    if (current === undefined || current === '') continue;
    env[variable] = withDatabaseName(current, databaseName);
  }
}

/**
 * The database a service-evidence row must land in: the one `verify:evidence`
 * opens in a later process, which is the stack's own rather than the calling
 * worker's clone. A row written to a clone is dropped with it at teardown and
 * then reads as a service that was never called — the same signal the verifier
 * exists to raise — so a caller that silently got the clone would be
 * undetectable, and an unpreserved base inside a worker throws here instead.
 *
 * What this does not give is run-scoping. In CI the job's database is created
 * fresh, so a row's presence is the fact that this run wrote it; locally the
 * stack's database persists, so a second run can satisfy a requirement with the
 * first run's row. Accepted: nothing local gates on `verify:evidence`.
 */
export function evidenceDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const captured = env[BASE_DATABASE_URL_VARIABLE];
  if (captured !== undefined && captured !== '') return captured;
  if (env[WORKER_SLOT_VARIABLE] !== undefined) {
    throw new Error(
      `test-db: ${BASE_DATABASE_URL_VARIABLE} is unset inside a vitest worker — the evidence row would land in a clone that teardown drops`
    );
  }
  const url = env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('test-db: DATABASE_URL is unset — no database can hold a service-evidence row');
  }
  return url;
}

/**
 * The creation instant, which only the pre-registry migration reads. A database
 * names its owning run in its own name ({@link testDatabaseRunToken}) and not
 * here, because a comment is a second statement and arrives too late to
 * attribute the database it describes.
 */
export function createdComment(now: Date): string {
  return `${CREATED_COMMENT_PREFIX}${now.toISOString()}`;
}

/**
 * Common prefix of every scratch bucket belonging to one run. The run records
 * this prefix against its claim, which is what lets a sweep attribute a bucket
 * it did not create: a bucket has no comment and no tag readable without a
 * second request, so the name is the only place the owner can live, and a
 * bucket name is too short to hold a claim id — the run token is what fits.
 */
export function scratchBucketPrefix(runToken: string): string {
  if (!RUN_TOKEN_REGEX.test(runToken)) {
    throw new Error(`test-db: invalid run token "${runToken}"`);
  }
  return `${SCRATCH_BUCKET_PREFIX}${runToken}-`;
}

/**
 * The name of one scratch bucket of the run holding `runToken`.
 *
 * The length is checked rather than trusted: a run token holds a whole run id
 * now, so the room left for the caller's suffix is small enough that a longer
 * one is a mistake worth catching here instead of at the object store, which
 * answers a bare rejection.
 */
export function scratchBucketName(runToken: string, id: string): string {
  const name = `${scratchBucketPrefix(runToken)}${id}`;
  if (name.length > MAX_BUCKET_NAME_LENGTH) {
    throw new Error(`test-db: bucket name "${name}" is longer than an object store allows`);
  }
  return name;
}

/**
 * The run token a scratch bucket carries, or undefined for one named before
 * buckets carried one. A token holds no hyphen, so the first segment is it.
 */
export function scratchBucketRunToken(bucket: string): string | undefined {
  if (!bucket.startsWith(SCRATCH_BUCKET_PREFIX)) return undefined;
  const [token, ...rest] = bucket.slice(SCRATCH_BUCKET_PREFIX.length).split('-');
  if (token === undefined || rest.length === 0 || !RUN_TOKEN_REGEX.test(token)) return undefined;
  return token;
}

export function templateComment(fingerprint: string): string {
  return `${TEMPLATE_COMMENT_PREFIX}${fingerprint}`;
}

export interface DatabaseRow {
  readonly datname: string;
  readonly comment: string | null;
}

/**
 * Debris from before the claim registry existed, selected by its creation stamp
 * because a database no claim can account for has nothing else left to read.
 *
 * A stamp that cannot be read is NOT selected. A database carries no comment
 * for the moment between its `CREATE` and its `COMMENT`, so reading an absent
 * stamp as an ancient one would destroy a database another run had just
 * created — the reading this selector is barred from making.
 *
 * Ownership is settled before this is consulted and overrules it either way:
 * only a database no claim accounts for reaches this selector, and one whose
 * run still holds its claim is never offered to it however old it is.
 *
 * The one-time migration {@link STALE_DATABASE_AGE_MS} describes; delete both
 * together.
 */
export function preRegistryDatabaseNames(
  rows: readonly DatabaseRow[],
  now: Date,
  maxAgeMs: number
): string[] {
  return rows
    .filter((row) => isPreRegistryDebris(row.comment, now, maxAgeMs))
    .map((row) => row.datname);
}

/**
 * Whether a database's comment carries a creation stamp this module can read.
 *
 * Exported so a reclaimer can select on the stamp without parsing the comment
 * for itself: the format is this module's, and a second reader of it would be
 * free to disagree with {@link createdComment} about what a stamp is. It
 * answers a question about the comment and never about the clock — a stamp is
 * readable or it is not, whatever instant it names.
 */
export function carriesReadableCreationStamp(comment: string | null): boolean {
  return parseCreatedAt(comment) !== undefined;
}

function isPreRegistryDebris(comment: string | null, now: Date, maxAgeMs: number): boolean {
  const createdAt = parseCreatedAt(comment);
  if (createdAt === undefined) return false;
  return now.getTime() - createdAt.getTime() > maxAgeMs;
}

function parseCreatedAt(comment: string | null): Date | undefined {
  if (!comment?.startsWith(CREATED_COMMENT_PREFIX)) return undefined;
  // A database stamped while the comment also carried an owner field still has
  // one trailing the instant, so only the first field is the instant.
  const [stamp] = comment.slice(CREATED_COMMENT_PREFIX.length).split(' ');
  if (stamp === undefined) return undefined;
  const parsed = new Date(stamp);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * A name for one staged or retired template database, unique per build and
 * never reissued, which is what lets the build record it against its run claim
 * as its own resource, and carrying the run it was minted for so that identity
 * survives the record. A minting instant is deliberately absent: whether a
 * staging database may be dropped is its owning run's claim, and an age here
 * would be a second answer nothing is entitled to read.
 *
 * A build killed after its run's claim holder exited cleanly used to leave a
 * name nothing on disk could attribute — reported on every later run and
 * removed by none. The run id in the name is what answers with no record left.
 *
 * Refuses a token whose name it could not read back, so nothing is created
 * under a name this module cannot attribute afterwards.
 */
export function mintStageDatabaseName(runToken: string): string {
  const suffix = randomBytes(STAGE_DATABASE_ID_BYTES).toString('hex');
  const name = `${STAGE_DATABASE_PREFIX}${runToken}${STAGE_INFIX}${suffix}`;
  if (name.length > MAX_DATABASE_NAME_LENGTH) {
    throw new Error(`test-db: staging name "${name}" is longer than an identifier holds`);
  }
  if (stageDatabaseRunToken(name) !== runToken) {
    throw new Error(`test-db: "${runToken}" cannot name a staging database this module can read`);
  }
  return name;
}

/**
 * The run token a staging database's name carries, or undefined for one named
 * before they carried one — the generation this cannot reach, which stays
 * reported and standing rather than being swept up.
 */
export function stageDatabaseRunToken(datname: string): string | undefined {
  if (!datname.startsWith(STAGE_DATABASE_PREFIX)) return undefined;
  const [token, suffix, ...rest] = datname.slice(STAGE_DATABASE_PREFIX.length).split(STAGE_INFIX);
  if (token === undefined || suffix === undefined || rest.length > 0) return undefined;
  return RUN_TOKEN_REGEX.test(token) ? token : undefined;
}

export function listStageDatabasesSql(): string {
  return `SELECT datname FROM pg_database WHERE starts_with(datname, '${STAGE_DATABASE_PREFIX}')`;
}

/** Database names are minted here, never taken from input; this pins that. */
export function quoteIdentifier(name: string): string {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(`test-db: "${name}" is not a legal database identifier`);
  }
  return `"${name}"`;
}

export function createDatabaseSql(name: string, template?: string): string {
  const base = `CREATE DATABASE ${quoteIdentifier(name)}`;
  return template === undefined ? base : `${base} TEMPLATE ${quoteIdentifier(template)}`;
}

export function commentDatabaseSql(name: string, comment: string): string {
  return `COMMENT ON DATABASE ${quoteIdentifier(name)} IS '${comment.replaceAll("'", "''")}'`;
}

/** FORCE so a leaked worker connection cannot block teardown. */
export function dropDatabaseSql(name: string): string {
  return `DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`;
}

/**
 * No FORCE, deliberately. A staged or retired template is reachable only to
 * the build that minted its name, so a session on one is a defect to surface
 * rather than a connection to terminate — and terminating sessions is what
 * made two concurrent template rebuilds kill each other.
 */
export function dropIdleDatabaseSql(name: string): string {
  return `DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`;
}

export function renameDatabaseSql(from: string, to: string): string {
  return `ALTER DATABASE ${quoteIdentifier(from)} RENAME TO ${quoteIdentifier(to)}`;
}

/**
 * Retires the live template and installs `staged` under its name. One string,
 * so a session runs it through the simple query protocol in a single round
 * trip on a single connection — which is what makes the pair atomic, a rename
 * being legal inside a transaction block. Nothing outside ever observes the
 * live name missing, and nothing ever creates or drops it.
 */
export function publishTemplateSql(staged: string, retired: string): string {
  return [
    'BEGIN',
    renameDatabaseSql(TEMPLATE_DATABASE, retired),
    renameDatabaseSql(staged, TEMPLATE_DATABASE),
    'COMMIT',
  ].join('; ');
}

export function listTestDatabasesSql(): string {
  return (
    "SELECT datname, shobj_description(oid, 'pg_database') AS comment FROM pg_database " +
    `WHERE starts_with(datname, '${TEST_DATABASE_PREFIX}')`
  );
}

export function templateFingerprintSql(): string {
  return (
    "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database " +
    `WHERE datname = '${TEMPLATE_DATABASE}'`
  );
}

/** Sessions connected to a database — the template must have none once built. */
export function connectionCountSql(name: string): string {
  return `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = '${name}'`;
}
