/**
 * Destinations for environment variables.
 *
 * An `as const` object rather than an `enum` because this package's modules are
 * loaded by plain Node — no bundler, no loader — and an enum is not erasable
 * syntax, so one anywhere in the graph stops the whole barrel loading. The
 * constraint is compiler-enforced here by `erasableSyntaxOnly`.
 */
export const Destination = {
  Backend: 'backend',
  Frontend: 'frontend',
  Scripts: 'scripts',
  Ops: 'ops', // → ops runner env blocks only (ci.yml ops-env + run-ops-script.yml ops-dispatch-env); never the API deploy's secrets file / runtime Worker
} as const;

export type Destination = (typeof Destination)[keyof typeof Destination];

/** Environment modes */
export const Mode = {
  Development: 'development',
  Test: 'test',
  CiVitest: 'ciVitest',
  E2E: 'e2e',
  CiE2E: 'ciE2E',
  Production: 'production',
} as const;

export type Mode = (typeof Mode)[keyof typeof Mode];

/**
 * The mode union under the name the registry's own API speaks — `ref`,
 * `getDestinations`, `getModeValue`, `resolveRaw` and `resolveValue` all take an
 * `EnvMode`, while `Mode` names the table those values come from. The two were
 * distinct types while the table was an enum, whose members a bare `'test'`
 * could not satisfy; the `as const` table makes them one union under two
 * published names, each imported in type position by different callers.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- see above: both names are published, and neither's callers can be moved from inside this package
export type EnvMode = Mode;

/** Reference to another environment's value */
export interface Ref {
  readonly _type: 'ref';
  readonly env: EnvMode;
}

/** Reference to a GitHub secret */
export interface Secret {
  readonly _type: 'secret';
  readonly name: string;
}

/** A value can be literal, reference, or secret */
export type EnvValue = string | Ref | Secret;

/** Mode value: just a value (uses default `to`) or value with destination override */
export type ModeValue = EnvValue | { value: EnvValue; to: Destination[] };

/** What replacing the value costs after a leak or on a schedule. */
export type ReplaceClass = 'transparent' | 'adminAction' | 'userMigration' | 'dead';

/** What happens when the value is gone and no attacker holds it. */
export type OnLoss = 'restoreFromCopy' | 'reissueAtVendor' | 'mintedPerDeploy';

/** What an attacker gains by reading the value; independent of the replacement class. */
export type LeakImpact = 'companyEnding' | 'severe' | 'expensive' | 'nuisance';

/**
 * Where the value lives. `github:*` names the GitHub environment holding the
 * secret (`github:repository` for one held at repository level, outside any
 * environment); `worker-only` is a Worker secret no GitHub secret backs.
 */
export type SecretStore =
  | 'github:production'
  | 'github:ci'
  | 'github:linear'
  | 'github:backup'
  | 'github:repository'
  | 'worker-only';

/** The credential families; each has its runbook at {@link runbookPath}. */
export const CREDENTIAL_FAMILIES = [
  'opaque-kek',
  'totp-encryption-secret',
  'random-secret',
  'vapid-keypair',
  'neon-role-password',
  'upstash-token',
  'cloudflare-api-token',
  'cloudflare-identifiers',
  'r2-token',
  'google-service-account',
  'openrouter-key',
  'brave-search-key',
  'resend-api-key',
  'resend-webhook-secret',
  'linear-key',
  'sentry-dsn',
  'hookdeck-key',
  'stryker-key',
  'gitleaks-license',
  'claude-code-token',
  'backblaze-key',
  'helcim-credentials',
  'github-app-key',
  'android-signing',
  'ios-signing',
  'deploy-minted',
] as const;

export type CredentialFamily = (typeof CREDENTIAL_FAMILIES)[number];

/**
 * The family's runbook, as a repo-relative document link. A link, not a
 * filesystem path: it is written into generated Markdown, where the separator
 * is fixed.
 */
export function runbookPath(family: CredentialFamily): string {
  return `docs/runbooks/secrets/${family}.md`;
}

/** What a secret is, where it lives, and what replacing or losing it costs. */
export interface Credential {
  readonly description: string;
  readonly store: SecretStore;
  readonly replace: ReplaceClass;
  readonly onLoss: OnLoss;
  readonly family: CredentialFamily;
  /** What users notice during a replacement; `'none'` when nothing. */
  readonly userVisible: string;
  /** Declaration keys that must change together with this one; symmetric. */
  readonly coupledWith?: readonly string[];
  readonly leakImpact: LeakImpact;
}

/** Configuration for a single environment variable */
export interface VariableConfig {
  readonly to: Destination[]; // default destinations
  /** Present exactly when some mode's value is a `secret(...)` marker. */
  readonly credential?: Credential;
  readonly [Mode.Development]?: ModeValue;
  readonly [Mode.Test]?: ModeValue;
  readonly [Mode.CiVitest]?: ModeValue;
  readonly [Mode.E2E]?: ModeValue;
  readonly [Mode.CiE2E]?: ModeValue;
  readonly [Mode.Production]?: ModeValue;
}

export const ref = (env: EnvMode): Ref => ({ _type: 'ref', env });
export const secret = (name: string): Secret => ({ _type: 'secret', name });

// Type guards (use unknown for idiomatic type guards that work on any input)
export const isRef = (v: unknown): v is Ref =>
  typeof v === 'object' && v !== null && '_type' in v && v._type === 'ref';
export const isSecret = (v: unknown): v is Secret =>
  typeof v === 'object' && v !== null && '_type' in v && v._type === 'secret';
export const isModeOverride = (v: unknown): v is { value: EnvValue; to: Destination[] } =>
  typeof v === 'object' && v !== null && 'value' in v && 'to' in v;

/** Get destinations for a specific mode (uses override or default). */
export function getDestinations(config: VariableConfig, mode: EnvMode): Destination[] {
  const modeValue = config[mode];
  if (modeValue === undefined) return [];
  if (isModeOverride(modeValue)) return modeValue.to;
  if (isRef(modeValue)) return getDestinations(config, modeValue.env);
  return config.to;
}

/** Get the raw EnvValue for a mode (unwraps override object) */

export function getModeValue(config: VariableConfig, mode: EnvMode): EnvValue | undefined {
  const modeValue = config[mode];
  if (modeValue === undefined) return undefined;
  if (isModeOverride(modeValue)) return modeValue.value;
  return modeValue;
}

/** Resolve a value, following refs (returns string or Secret, never Ref) */
// eslint-disable-next-line sonarjs/function-return-type -- intentional optional return
export function resolveRaw(config: VariableConfig, mode: EnvMode): string | Secret | undefined {
  const raw = getModeValue(config, mode);
  if (raw === undefined) return undefined;
  if (isRef(raw)) return resolveRaw(config, raw.env);
  return raw;
}

/** Resolve to final string value */
export function resolveValue(
  config: VariableConfig,
  mode: EnvMode,
  getSecret: (name: string) => string
): string | null {
  const raw = resolveRaw(config, mode);
  /* istanbul ignore next -- @preserve defensive check */
  if (raw === undefined) return null;
  if (isSecret(raw)) return getSecret(raw.name);
  return raw;
}

/** Check if production value resolves to a secret */
export function isProductionSecret(config: VariableConfig): boolean {
  const raw = resolveRaw(config, Mode.Production);
  return raw !== undefined && isSecret(raw);
}

/**
 * Check if any mode's value resolves to a secret — the entry holds a credential.
 *
 * The `secret(...)` marker is per-mode, and entries exist that carry one in a CI
 * mode and have no production value at all, so production alone under-reports
 * which entries are credential-bearing.
 */
export function isAnyModeSecret(config: VariableConfig): boolean {
  return Object.values(Mode).some((mode) => isSecret(resolveRaw(config, mode)));
}
