import { Mode, resolveRaw } from '@hushbox/shared';
import { envConfig } from '@hushbox/shared/env.config';
import { DEFAULT_STACK_MODE } from './stack-mode.js';
import { applyStackDatabase, databaseNameOf } from './stack-database.js';
import type { VariableConfig } from '@hushbox/shared';

/**
 * The values `docker-compose.yml` interpolates that are not a registry entry a
 * stack's own env file already carries, derived here from the registry's one
 * spelling and written into the scripts env file by `scripts/generate-env.ts`.
 *
 * Two things put a value here rather than in the compose file's `${NAME}`
 * straight off a registry entry. It may be spelled inside another value, as the
 * Postgres role is inside the connection string. Or it may have to be the same
 * for every stack: these all resolve the development stack in every stack's
 * file, and that is the point rather than an oversight. One compose project holds one Postgres
 * cluster and one MinIO volume however many stacks a checkout runs, so a value
 * varying with the stack that happened to bring the project up would vary the
 * containers themselves: the cluster is born with whichever database was
 * resolved first, and `docker compose config --hash` — what the bring-up
 * compares to decide whether a container still matches the file — would differ
 * per stack and recreate the containers on every switch. Each stack still
 * reaches a data plane of its own; what makes that true is the database and
 * bucket its own generated env files name, which the bring-up creates.
 */

/** The variable each value is written into, and the compose file reads back. */
export const COMPOSE_ENV_VARIABLES = {
  postgresDb: 'HB_POSTGRES_DB',
  postgresUser: 'HB_POSTGRES_USER',
  // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a variable's name, not a value
  postgresPassword: 'HB_POSTGRES_PASSWORD',
  minioRootUser: 'HB_MINIO_ROOT_USER',
  // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a variable's name, not a value
  minioRootPassword: 'HB_MINIO_ROOT_PASSWORD',
  escrowBucket: 'HB_ESCROW_BUCKET',
} as const;

type ComposeEnvVariable = (typeof COMPOSE_ENV_VARIABLES)[keyof typeof COMPOSE_ENV_VARIABLES];

/**
 * The bucket the secret-escrow drill writes to against the local object store.
 *
 * The registry spells no bucket of its own, and this one is no exception to
 * that: it names an emulator bucket no application code opens, and the escrow
 * run outside a developer's machine takes its bucket from the `ESCROW_B2_BUCKET`
 * variable instead. So it is spelled here, once, beside the media bucket that
 * the same `minio-setup` entrypoint creates.
 */
const ESCROW_BUCKET = 'hushbox-escrow-dev';

/**
 * The literal a registry entry resolves outside production, or a refusal.
 *
 * A refusal rather than a fallback: an entry whose development value became a
 * secret, or went away, leaves nothing to derive a compose value from, and a
 * container born on a blank is the failure the whole substitution exists to
 * prevent.
 */
export function developmentValue(name: keyof typeof envConfig): string {
  const raw = resolveRaw(envConfig[name] as VariableConfig, Mode.Development);
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(
      `compose-env: the registry entry ${name} carries no development value, so nothing can be derived from it for docker-compose.yml`
    );
  }
  return raw;
}

/** The connection string every local client opens the default stack's database with. */
function defaultStackDatabaseUrl(): URL {
  return new URL(applyStackDatabase(developmentValue('DATABASE_URL'), DEFAULT_STACK_MODE));
}

/**
 * What the compose file interpolates, keyed by the variable it reads.
 *
 * The Postgres role comes out of the connection string rather than beside it,
 * because the string is where the registry spells that pair; the object store's
 * root credentials are the very pair its clients present, since the emulator
 * holds one account.
 */
export function composeEnvValues(): Readonly<Record<ComposeEnvVariable, string>> {
  const databaseUrl = defaultStackDatabaseUrl();
  return {
    [COMPOSE_ENV_VARIABLES.postgresDb]: databaseNameOf(databaseUrl.href),
    [COMPOSE_ENV_VARIABLES.postgresUser]: decodeURIComponent(databaseUrl.username),
    [COMPOSE_ENV_VARIABLES.postgresPassword]: decodeURIComponent(databaseUrl.password),
    [COMPOSE_ENV_VARIABLES.minioRootUser]: developmentValue('R2_ACCESS_KEY_ID'),
    [COMPOSE_ENV_VARIABLES.minioRootPassword]: developmentValue('R2_SECRET_ACCESS_KEY'),
    [COMPOSE_ENV_VARIABLES.escrowBucket]: ESCROW_BUCKET,
  };
}

/**
 * The Postgres role an already-loaded environment names. It is the role the
 * cluster was born holding, so it is also the one a maintenance command inside
 * the container connects as.
 */
export function postgresRoleFrom(env: NodeJS.ProcessEnv): string {
  const role = env[COMPOSE_ENV_VARIABLES.postgresUser];
  if (role === undefined || role === '') {
    throw new Error(
      'compose-env: HB_POSTGRES_USER names no role — the stack env is not loaded. Run pnpm generate:env and invoke through pnpm.'
    );
  }
  return role;
}

/**
 * The escrow bucket an already-loaded environment names, read the way
 * `mediaBucketFrom` reads the media bucket: what has to exist is the bucket the
 * compose file created, not one a caller worked out for itself.
 */
export function escrowBucketFrom(env: NodeJS.ProcessEnv): string {
  const bucket = env[COMPOSE_ENV_VARIABLES.escrowBucket];
  if (bucket === undefined || bucket === '') {
    throw new Error(
      'compose-env: HB_ESCROW_BUCKET names no bucket — the stack env is not loaded. Run pnpm generate:env and invoke through pnpm.'
    );
  }
  return bucket;
}
