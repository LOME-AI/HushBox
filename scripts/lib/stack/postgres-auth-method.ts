/**
 * Keeps the local Postgres cluster asking for the authentication the driver
 * sends. This is the one place that pairing and its consequence are stated;
 * `docker-compose.yml` and `packages/db/src/client.ts` point here.
 *
 * The driver pipelines a cleartext password with the startup message
 * (`pipelineConnect` in `packages/db/src/client.ts`), which means it answers an
 * authentication request it has not read yet. The server therefore has to be
 * asking for cleartext `password`: against a cluster asking `scram-sha-256` the
 * connect was measured to fail outright, which is a hard failure on every
 * database call rather than a slow path.
 *
 * Which method the cluster asks for is decided at initialisation and never
 * again. The image's entrypoint appends the catch-all rule carrying
 * `POSTGRES_HOST_AUTH_METHOD` (`docker-compose.yml`) on the branch that
 * initialises an empty data directory and on no other, so a volume made before
 * that setting keeps the method it was born with for as long as it exists.
 * Repairing it is a rewrite of one token per rule plus a configuration reload —
 * no restart, and nothing in the volume beyond `pg_hba.conf` is touched, which
 * is why the bring-up can do it rather than sending the developer to a wipe.
 *
 * Pure orchestration; reading the rules and rewriting them are injected
 * (`postgres-auth-method-docker.ts` supplies the pair the bring-up uses).
 */

/** One `host`-family rule of `pg_hba.conf`, as `pg_hba_file_rules` reports it. */
export interface HostAuthRule {
  readonly lineNumber: number;
  /** Empty where the view could not report one, which is a rule nothing can rewrite. */
  readonly authMethod: string;
}

export interface PostgresAuthMethodDeps {
  /**
   * The cluster's `host`-family rules. The view reads the file on disk rather
   * than the rules the server last loaded, so what comes back is what a reload
   * would put into effect.
   */
  readHostRules: () => Promise<readonly HostAuthRule[]>;
  /** Rewrites each named rule's method to `password` and reloads the server. */
  acceptPasswordOn: (rules: readonly HostAuthRule[]) => Promise<void>;
  /** Narrates a repair to the operator. A no-op bring-up says nothing. */
  report: (message: string) => void;
}

/**
 * The methods the repair leaves alone. `password` is the one the driver's
 * pipelined connect was measured to reach the server through. `trust` is here
 * because `initdb` writes the loopback `host` rules as `trust` on every volume
 * and the image only appends its own catch-all line beneath them, so treating
 * `trust` as blocking would rewrite those rules on every bring-up and there
 * would be no no-op path left.
 */
const PIPELINED_CONNECT_METHODS: ReadonlySet<string> = new Set(['password', 'trust']);

/** The method the repair writes, and the one the driver's pipelined connect answers. */
const REPAIRED_METHOD = 'password';

export function rulesBlockingPipelinedConnect(
  rules: readonly HostAuthRule[]
): readonly HostAuthRule[] {
  return rules.filter((rule) => !PIPELINED_CONNECT_METHODS.has(rule.authMethod));
}

function describe(rules: readonly HostAuthRule[]): string {
  return rules
    .map((rule) => `line ${String(rule.lineNumber)} (${rule.authMethod || 'unreadable'})`)
    .join(', ');
}

function refusal(rules: readonly HostAuthRule[]): Error {
  return new Error(
    `ensure-stack: the local Postgres still asks for an authentication method the driver's ` +
      `pipelined connect cannot answer — ${describe(rules)}. Every database call will fail ` +
      'until that rule asks for `password`. Rewriting it in place did not take, so the ' +
      'remaining repair is `pnpm db:reset`, which rebuilds the volume with the method the ' +
      'compose file selects.'
  );
}

export async function ensurePostgresAcceptsPassword(deps: PostgresAuthMethodDeps): Promise<void> {
  const blocking = rulesBlockingPipelinedConnect(await deps.readHostRules());
  if (blocking.length === 0) return;

  // A rule the view reports no method for is one the rewrite has no token to
  // replace, so it goes straight to the refusal rather than through a rewrite
  // that would silently match nothing.
  if (blocking.some((rule) => rule.authMethod === '')) throw refusal(blocking);

  deps.report(
    `ensure-stack: the local Postgres asks for ${describe(blocking)}, which the driver's ` +
      `pipelined connect cannot answer — rewriting to \`${REPAIRED_METHOD}\` and reloading.`
  );
  await deps.acceptPasswordOn(blocking);

  const remaining = rulesBlockingPipelinedConnect(await deps.readHostRules());
  if (remaining.length > 0) throw refusal(remaining);
}
