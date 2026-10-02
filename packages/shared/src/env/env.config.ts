/* eslint-disable max-lines -- the environment registry is one table whose keys are every variable the system has; a fragment of it is not a registry, and its length is that count rather than anything a split removes */
import { z } from 'zod';
import { ENV_FLAG_TRUE } from './env.ts';
import { BRAVE_SEARCH_API_KEY_PLACEHOLDER } from './local-placeholders.ts';
import { ref, secret, Destination, Mode, type VariableConfig } from './env-types.ts';

export {
  Destination,
  getDestinations,
  isAnyModeSecret,
  isProductionSecret,
  isSecret,
  Mode,
  ref,
  resolveRaw,
  resolveValue,
  secret,
} from './env-types.ts';
export type { EnvMode, VariableConfig } from './env-types.ts';

/**
 * Environment configuration with typed values.
 *
 * Each var has:
 * - `to`: Default destinations for this var
 * - Per-mode values: `Mode.Development`, `Mode.CiVitest`, `Mode.E2E`, `Mode.CiE2E`, `Mode.Production`
 * - `credential`: on every var with a `secret()` marker in any mode — what it
 *   is, where it lives, what replacing or losing it costs (`docs/SECRETS.md`)
 *
 * Value types:
 * - `'literal'`                    - Use this exact string
 * - `ref(Mode.X)`                  - Use same value as another mode
 * - `secret('NAME')`               - Read from GitHub secret at runtime
 * - `{ value: ..., to: [...] }`    - Override destinations for this mode
 *
 * A local-stack origin is written `<service>.localhost`, naming a service of
 * the port plan rather than a port; `scripts/generate-env.ts` substitutes the
 * `localhost:<port>` that service holds for the checkout's slot and stack mode,
 * and refuses a name no service declares. A port literal here would be a second
 * spelling of an allocation the generator already owns, with nothing to catch
 * the two disagreeing. The name sits in host position rather than port position
 * so every value stays a URL a parser accepts before substitution, and it is
 * the service key lowercased because `URL` lowercases a hostname: a capital
 * would make the value differ from its own origin, which is what the loopback
 * exemption in `env-registry-content.ts` tests for.
 *
 * Destinations, at the paths `generatedEnvPaths` in `scripts/generate-env.ts`
 * gives the mode:
 * - `Destination.Backend`  → the dev-vars file (local) / wrangler.toml + secrets (prod)
 * - `Destination.Frontend` → the Vite env file (VITE_* vars only)
 * - `Destination.Scripts`  → the scripts env file (migrations, seed, etc.)
 * - `Destination.Ops`      → ops runner env blocks only (ci.yml ops-env +
 *                            run-ops-script.yml ops-dispatch-env); never
 *                            the API deploy's secrets file / runtime Worker
 */
/**
 * What a registry value writes where a local stack's own Postgres database
 * goes. `scripts/generate-env.ts` substitutes the database belonging to the
 * stack whose files it is writing, and the stack plan is what decides that
 * name — so the registry, exactly as with ports, spells nothing that could
 * drift from the stack it names. A marker rather than a name also keeps the
 * value a URL a parser accepts before substitution.
 */
export const STACK_DATABASE_MARKER = 'stack.database';

/**
 * What a registry value writes where a local stack's own object-storage bucket
 * goes, for the reason {@link STACK_DATABASE_MARKER} exists: the bucket is part
 * of a stack's identity, so the stack plan decides its name and the registry
 * asks for it rather than spelling one that could drift.
 */
export const STACK_BUCKET_MARKER = 'stack.bucket';

/**
 * The document sandbox origin, read by both registry entries that name it: the
 * build-time one the sandbox tooling bakes and the `VITE_` one the web bundle
 * reads. One value set is what keeps the app-origin CSP `frame-src` and the
 * iframe `src` naming the same host.
 */
const SANDBOX_ORIGIN_BY_MODE = {
  [Mode.Development]: 'http://sandbox.localhost',
  [Mode.Test]: ref(Mode.Development),
  [Mode.CiVitest]: ref(Mode.Development),
  [Mode.E2E]: ref(Mode.Development),
  [Mode.CiE2E]: ref(Mode.E2E),
  [Mode.Production]: 'https://sandbox.hushbox.ai',
} as const satisfies Omit<VariableConfig, 'to' | 'credential'>;

/**
 * The day both legal effective dates carry outside production. Every published
 * effective date is derived from the release tags by
 * `scripts/legal-effective-dates.ts`, and nothing derives one for a local
 * checkout — so what the pages render there has to be a well-formed day that no
 * reader can mistake for a published one. The epoch reads as the placeholder it
 * is; any plausible day would read as a legal fact.
 */
const UNDERIVED_EFFECTIVE_DATE = '1970-01-01';

export const envConfig = {
  // Backend + Scripts in dev (seed.ts needs it), Backend only in CI/prod
  DATABASE_URL: {
    to: [Destination.Backend],
    credential: {
      description:
        'Connection string for the application Postgres role on Neon: full read and write on every table.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'neon-role-password',
      userVisible:
        'requests fail from the password reset until the deploy carrying the new value completes',
      coupledWith: ['ADMIN_SQL_PANEL_DATABASE_URL', 'GROWTH_READER_DATABASE_URL'],
      leakImpact: 'companyEnding',
    },
    [Mode.Development]: {
      value: `postgres://hushbox_app:hushbox_app@neon.localhost/${STACK_DATABASE_MARKER}`,
      to: [Destination.Backend, Destination.Scripts],
    },
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development), // Backend only (uses default `to`)
    [Mode.E2E]: ref(Mode.Development), // Backend only (uses default `to`)
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('DATABASE_URL'), // Backend only (uses default `to`)
  },

  // Backend only
  NODE_ENV: {
    to: [Destination.Backend],
    [Mode.Development]: 'development',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'production',
  },

  API_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://api.localhost',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://api.hushbox.ai',
  },

  FRONTEND_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://vite.localhost',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://hushbox.ai',
  },

  // The marketing site's origin. Consumed by the newsletter email link builders
  // (confirm/unsubscribe URLs point at the Astro pages) and admitted by the CORS
  // allowlist. Separate from FRONTEND_URL because the two coincide in production
  // (marketing is served from hushbox.ai) but diverge in dev, where marketing
  // runs on its own Astro port.
  MARKETING_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://astro.localhost',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://hushbox.ai',
  },

  FRONTEND_PREVIEW_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://preview.localhost',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
  },

  // The admin SPA's own origin, admitted by the CSRF Origin check (browsers
  // send Origin on all POSTs, same-origin included — without this entry every
  // production admin mutation would 403). Dev/E2E point at the local admin
  // dev server.
  ADMIN_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://admin.localhost',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://admin.hushbox.ai',
  },

  // The dedicated, credential-free sandbox origin that serves the document
  // renderer pages + self-hosted Pyodide assets. Untrusted document code runs
  // there, so this must never point at the app origin: the renderer's lockdown
  // CSP and cookie-free posture come from that host's own responses, not from
  // the iframe's `sandbox` attribute. Read at BUILD time only — the app-origin
  // CSP `frame-src` allows it, and the sandbox dev/build tooling bakes it — so
  // it is a Scripts var (no runtime Worker consumer, no production secret). The
  // web app's own iframe `src` reads the VITE_ mirror. Dev points at the local
  // sandbox dev server.
  SANDBOX_ORIGIN_URL: {
    to: [Destination.Scripts],
    ...SANDBOX_ORIGIN_BY_MODE,
  },

  // Frontend mirror of SANDBOX_ORIGIN_URL — the value the web bundle reads at
  // runtime to point the document-panel sandbox iframe `src` at the renderer
  // pages, and the app-origin CSP `frame-src` in index.html (Vite substitutes
  // %VITE_SANDBOX_ORIGIN_URL% at build time).
  VITE_SANDBOX_ORIGIN_URL: {
    to: [Destination.Frontend],
    ...SANDBOX_ORIGIN_BY_MODE,
  },

  // Module-CDN base URL the document renderer assembles its import map against.
  // Production and dev-default resolve npm ES modules from
  // esm.sh; the modes whose runs serve a sandbox origin point at a local static
  // stub it serves, so those runs are deterministic and never hit live network
  // (mirrors the AI-cassette doctrine). The local mode of the test stack keeps
  // the development value: that stack binds no host port, so it serves nothing
  // this could be baked into. Baked into the renderer at sandbox build/serve
  // time — a Scripts var, read via the sandbox tooling.
  ESM_CDN_URL: {
    to: [Destination.Scripts],
    [Mode.Development]: 'https://esm.sh',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: 'http://sandbox.localhost/esm-stub',
    [Mode.E2E]: ref(Mode.CiVitest),
    [Mode.CiE2E]: ref(Mode.CiVitest),
    [Mode.Production]: 'https://esm.sh',
  },

  // Stated by the modes that are CI and by no other, because absent is how a
  // mode says no here. The name belongs to the platforms that set it, whose
  // convention is presence rather than value: every spelling of a denial is
  // still present, and installed tooling classifies on presence alone, so
  // writing one withdraws colour and interactivity from every local command.
  // `clearUnemittedClassification` in `scripts/with-env.ts` is what makes the
  // omission bind — it removes this variable from the environment of a command
  // whose loaded files were generated under a mode that states nothing here, so
  // a runner's own value cannot survive into one. A mode that runs no stack
  // loads no files and is not reached by it.
  CI: {
    to: [Destination.Backend],
    [Mode.CiVitest]: ENV_FLAG_TRUE,
    [Mode.CiE2E]: ENV_FLAG_TRUE,
    // NOT in E2E — local e2e is not CI
  },

  E2E: {
    to: [Destination.Backend],
    [Mode.E2E]: ENV_FLAG_TRUE,
    [Mode.CiE2E]: ref(Mode.E2E),
  },

  // Redis (Upstash in prod, SRH locally)
  UPSTASH_REDIS_REST_URL: {
    to: [Destination.Backend],
    credential: {
      description:
        'The Upstash Redis REST endpoint address; an identifier that pairs with the token.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'upstash-token',
      userVisible: 'none',
      coupledWith: ['UPSTASH_REDIS_REST_TOKEN'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'http://redishttp.localhost',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('UPSTASH_REDIS_REST_URL'),
  },

  UPSTASH_REDIS_REST_TOKEN: {
    to: [Destination.Backend],
    credential: {
      description:
        'Full command access to the Upstash Redis instance: admission holds, rate-limit counters, OPAQUE challenge state, membership cache.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'upstash-token',
      userVisible:
        'paid runs are refused from the token reset until the deploy carrying the new value completes',
      coupledWith: ['UPSTASH_REDIS_REST_URL'],
      leakImpact: 'severe',
    },
    // Isolation between the local stacks is the CONNECTION, not a key prefix:
    // each token selects its own logical Redis database inside the one
    // Serverless-Redis-HTTP container, whose pools `docker/srh-tokens.json`
    // declares. A prefix has no choke point to sit in — the rate-limit layer
    // mints keys outside the key registry, and the dev reset routes respell key
    // shapes by hand — so it would miss those silently, turning a reset into a
    // no-op that still reports success. The token reaches every client instead,
    // because every one of them takes it from here.
    [Mode.Development]: 'local_dev_token',
    // The two modes of the test stack reach one pool, so the token that selects
    // it is spelled once — on the local mode, so that resolving it locally
    // never walks into the mode whose other values are CI secrets.
    [Mode.Test]: 'local_test_token',
    [Mode.CiVitest]: ref(Mode.Test),
    [Mode.E2E]: 'local_e2e_token',
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('UPSTASH_REDIS_REST_TOKEN'),
  },

  // How long one Redis round trip may take before it is abandoned as
  // unreachable, for every reader of this store inside an isolate rather than
  // for a counter check alone. The request isolate, the cron isolate and the
  // conversation room each put this value in force and build their Redis
  // client under it, so a rate-limit counter is one reader among the rest —
  // the session-liveness check every authenticated request makes, the
  // one-time-code claim, the handshake state, the admission hold. Raising it
  // therefore lengthens how long an authenticated request blocks before it is
  // refused, not only what a rate-limited route absorbs.
  // The production value is reasoned rather than measured; what round trips to
  // this store actually take, and why no mode's bound is sized to that
  // distribution, is recorded with the client this value parameterises
  // (`createBoundedRedis` in `apps/api/src/lib/resilience/bounded-redis.ts`).
  // Every non-production mode is deliberately loose: they all reach Redis
  // through the SRH proxy on a host running the stack, the browsers and the
  // suite at once, where a tight bound measures the proxy and the host rather
  // than the endpoint it exists to protect, and a spuriously abandoned check
  // turns a counting test into a fail-closed refusal.
  RATE_LIMIT_REDIS_TIMEOUT_MS: {
    to: [Destination.Backend],
    [Mode.Development]: '5000',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: '500',
  },

  // HMAC key every rate-limit identifier is keyed under before it names a Redis
  // key, so the store holds no email, login identifier or verification token,
  // and an unkeyed digest of one cannot be reversed against a dictionary.
  // Nothing durable depends on it: a replacement resets every counter window
  // once.
  RATE_LIMIT_KEY_SECRET: {
    to: [Destination.Backend],
    credential: {
      description:
        'Keys every rate-limit identifier before it names a Redis key; a holder with the keyspace can test guessed emails and identifiers against the counters.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'random-secret',
      userVisible: 'none',
      leakImpact: 'expensive',
    },
    [Mode.Development]: '4xYgniBOuLUIflgSUYO2tiThofPugB2wP5Jxiw_GjEQ',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('RATE_LIMIT_KEY_SECRET'),
  },

  // Key-encryption key sealing each user's OPAQUE server material (OPRF seed +
  // AKE keypair) in the users row. The material never changes across a swap of
  // this key; the re-seal ops script re-wraps every row under OPAQUE_KEK_NEXT.
  OPAQUE_KEK: {
    to: [Destination.Backend],
    credential: {
      description:
        'Key-encryption key sealing every user OPAQUE server material blob in the users row; the row carries its fingerprint.',
      store: 'github:production',
      replace: 'adminAction',
      onLoss: 'restoreFromCopy',
      family: 'opaque-kek',
      userVisible: 'the API is down for the re-seal job and the deploy that follows',
      leakImpact: 'companyEnding',
    },
    [Mode.Development]: 'dev-opaque-kek-32-bytes-minimum-literal',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('OPAQUE_KEK'),
  },

  // The incoming KEK during a re-seal: read by the re-seal ops script and by the
  // escrow, which encrypts it beside the live key. Ops-destined, so it never
  // reaches the runtime Worker.
  OPAQUE_KEK_NEXT: {
    to: [Destination.Ops],
    credential: {
      description:
        'The incoming key-encryption key during a re-seal, read by the re-seal ops script and by the escrow; it repeats the live KEK between rotations, because the runner refuses an empty secret.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'opaque-kek',
      userVisible: 'none',
      leakImpact: 'severe',
    },
    [Mode.Development]: 'dev-opaque-kek-next-32-bytes-minimum',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('OPAQUE_KEK_NEXT'),
  },

  // Seals each user's stored TOTP secret; its own key so it rotates on its own
  // lifecycle, through the same re-seal job.
  TOTP_ENCRYPTION_SECRET: {
    to: [Destination.Backend],
    credential: {
      description:
        'Seals each user stored TOTP secret; every blob carries this key fingerprint as its key id.',
      store: 'github:production',
      replace: 'adminAction',
      onLoss: 'restoreFromCopy',
      family: 'totp-encryption-secret',
      userVisible: 'the API is down for the re-seal job and the deploy that follows',
      leakImpact: 'severe',
    },
    [Mode.Development]: 'dev-totp-encryption-secret-32-bytes-min',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('TOTP_ENCRYPTION_SECRET'),
  },

  // The incoming TOTP encryption secret during a re-seal: read by the re-seal
  // ops script and by the escrow, which encrypts it beside the live secret.
  // Ops-destined, so it never reaches the runtime Worker. Outside a rotation it
  // holds the live value, which the re-seal job reads as "this key is not being
  // rotated in this run".
  TOTP_ENCRYPTION_SECRET_NEXT: {
    to: [Destination.Ops],
    credential: {
      description:
        'The incoming TOTP encryption secret during a re-seal, read by the re-seal ops script and by the escrow; it repeats the live secret between rotations, because the runner refuses an empty secret.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'totp-encryption-secret',
      userVisible: 'none',
      leakImpact: 'severe',
    },
    [Mode.Development]: 'dev-totp-encryption-secret-next-32-min',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('TOTP_ENCRYPTION_SECRET_NEXT'),
  },

  // Derives the fake registration record and recovery dummies served for an
  // unknown identifier, so the unknown path costs the same work as a real row.
  // Nothing stored depends on it.
  ENUMERATION_DECOY_SECRET: {
    to: [Destination.Backend],
    credential: {
      description:
        'Derives the fake registration record and recovery dummies served for unknown identifiers; nothing stored depends on it.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'random-secret',
      userVisible: 'none',
      leakImpact: 'severe',
    },
    [Mode.Development]: 'dev-enumeration-decoy-secret-32-bytes',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('ENUMERATION_DECOY_SECRET'),
  },

  // iron-session secret for encrypted cookies
  IRON_SESSION_SECRET: {
    to: [Destination.Backend],
    credential: {
      description: 'Seals every session cookie; forging one impersonates any user at the API.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'random-secret',
      userVisible: 'everyone signs in again once',
      leakImpact: 'severe',
    },
    [Mode.Development]: 'dev-iron-session-secret-32-bytes-min',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('IRON_SESSION_SECRET'),
  },

  // ── Admin plane: Cloudflare Access JWT verification ──────────────────────
  // The `admin` route class verifies `Cf-Access-Jwt-Assertion` in-Worker
  // (jose): issuer `https://<CF_ACCESS_TEAM_DOMAIN>.cloudflareaccess.com`,
  // audience CF_ACCESS_AUD, actor email against ADMIN_ACTOR_ALLOWLIST —
  // fail-closed. Production resolves the real Access app's values as secrets;
  // dev/CI carry literals the dev-admin mint route signs against.
  CF_ACCESS_TEAM_DOMAIN: {
    to: [Destination.Backend],
    credential: {
      description:
        'The Cloudflare Access team domain the admin JWT issuer and JWKS URL are built from; it appears in every issued Access JWT.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'cloudflare-identifiers',
      userVisible: 'none',
      coupledWith: ['CF_ACCESS_AUD'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'hushbox-dev',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('CF_ACCESS_TEAM_DOMAIN'),
  },

  CF_ACCESS_AUD: {
    to: [Destination.Backend],
    credential: {
      description:
        'The Access application audience tag checked on admin JWTs; grants nothing without a validly signed assertion.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'cloudflare-identifiers',
      userVisible: 'none',
      coupledWith: ['CF_ACCESS_TEAM_DOMAIN'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'dev-admin-access-aud',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('CF_ACCESS_AUD'),
  },

  // Exact-match admin actor emails, comma-separated (1–3 entries; never a
  // domain-wide rule — ARCHITECTURE §Admin plane). The in-Worker check mirrors the
  // Access app's own allowlist: the belt behind the edge wall.
  ADMIN_ACTOR_ALLOWLIST: {
    to: [Destination.Backend],
    credential: {
      description:
        'The exact-match admin actor email addresses the in-Worker check compares against; discloses who the operators are and grants nothing.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'cloudflare-identifiers',
      userVisible: 'none',
      coupledWith: ['ADMIN_ROLE_MAP'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'admin@hushbox.test,ops@hushbox.test,viewer@hushbox.test',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('ADMIN_ACTOR_ALLOWLIST'),
  },

  // The admin plane's role registry: `email=role` pairs over the closed
  // ADMIN_ROLES set, read by the same parser the allowlist uses. An
  // allowlisted email with no entry here is refused (401), so this is the
  // authoritative statement of who the plane authorizes and as what. The wall
  // admits an address only when this map AND the allowlist carry it, and that
  // intersection is the set the Access-log auditor expects to see
  // authenticate; the operator subset of this map is who the operational mail
  // and the daily digest go to.
  ADMIN_ROLE_MAP: {
    to: [Destination.Backend],
    credential: {
      description:
        'The admin actor email to role assignments the in-Worker check authorizes against; discloses who the operators are and grants nothing.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'cloudflare-identifiers',
      userVisible: 'none',
      coupledWith: ['ADMIN_ACTOR_ALLOWLIST'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]:
      'admin@hushbox.test=operator,ops@hushbox.test=operator,viewer@hushbox.test=growth-viewer',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('ADMIN_ROLE_MAP'),
  },

  // Connection string for the SELECT-only `growth_reader` Postgres role: SELECT
  // on the growth views and nothing else, so a defect on the read-only role's
  // path still cannot produce a write. Dev/CI point at local Postgres through
  // the neon proxy, like the SQL panel's role; the role is created NOLOGIN by
  // its migration (its production login password is minted out-of-band), so
  // local login as the role additionally requires an out-of-band
  // `ALTER ROLE growth_reader LOGIN PASSWORD 'growth_reader'`. Production is
  // the full URL as a secret.
  GROWTH_READER_DATABASE_URL: {
    to: [Destination.Backend],
    credential: {
      description: 'Connection string for the SELECT-only growth_reader Postgres role.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'neon-role-password',
      userVisible: 'none',
      coupledWith: ['DATABASE_URL'],
      leakImpact: 'severe',
    },
    // eslint-disable-next-line no-secrets/no-secrets -- the local dev role's own name as its password, exactly like ADMIN_SQL_PANEL_DATABASE_URL below; production is a secret and never a literal
    [Mode.Development]: `postgres://growth_reader:growth_reader@neon.localhost/${STACK_DATABASE_MARKER}`,
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('GROWTH_READER_DATABASE_URL'),
  },

  // Connection string for the SELECT-only `admin_sql_panel` Postgres role
  // (created in-chain by the admin-plane foundations migration). Dev/CI point
  // at local Postgres through the neon proxy; the role is created NOLOGIN by
  // the migration (its production login password is minted out-of-band), so
  // local login as the role additionally requires an out-of-band
  // `ALTER ROLE admin_sql_panel LOGIN PASSWORD 'admin_sql_panel'`. Production
  // is the full URL as a secret — the credential never appears in code.
  ADMIN_SQL_PANEL_DATABASE_URL: {
    to: [Destination.Backend],
    credential: {
      description: 'Connection string for the SELECT-only admin_sql_panel Postgres role.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'neon-role-password',
      userVisible: 'none',
      coupledWith: ['DATABASE_URL'],
      leakImpact: 'severe',
    },
    [Mode.Development]: `postgres://admin_sql_panel:admin_sql_panel@neon.localhost/${STACK_DATABASE_MARKER}`,
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('ADMIN_SQL_PANEL_DATABASE_URL'),
  },

  // Cloudflare API token (Access authentication-logs read scope) for the
  // admin plane's Access-log pull cron. Dev/CI use a placeholder literal —
  // the puller is mocked locally, never a live Cloudflare call.
  CLOUDFLARE_ACCESS_LOG_API_TOKEN: {
    to: [Destination.Backend],
    credential: {
      description:
        'Cloudflare API token the admin plane Access-log pull cron reads authentication logs with.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'cloudflare-api-token',
      userVisible: 'none',
      leakImpact: 'expensive',
    },
    [Mode.Development]: 'mock-cloudflare-access-log-token',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('CLOUDFLARE_ACCESS_LOG_API_TOKEN'),
  },

  // The Cloudflare account id the Access-log pull cron's API path embeds
  // (/accounts/{account_id}/access/logs/access_requests). Dev/CI use a
  // placeholder literal — the puller is mocked locally, never a live
  // Cloudflare call; production supplies the real id alongside the token.
  CLOUDFLARE_ACCOUNT_ID: {
    to: [Destination.Backend],
    credential: {
      description: 'The Cloudflare account identifier embedded in API paths; not confidential.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'cloudflare-identifiers',
      userVisible: 'none',
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'mock-cloudflare-account-id',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('CLOUDFLARE_ACCOUNT_ID'),
  },

  // The DEV-ONLY Access signing key (Ed25519 private JWK, committed — a local
  // fixture, never a production secret). The dev-admin mint route signs
  // Access-shaped JWTs with it and the admin JWT stage derives its LOCAL JWKS
  // from its public half. Production deliberately carries NO value: nothing
  // deployable can mint admin access (CODE-RULES §Admin Operations; asserted
  // by test).
  CF_ACCESS_DEV_PRIVATE_JWK: {
    to: [Destination.Backend],
    [Mode.Development]:
      '{"kty":"OKP","crv":"Ed25519","alg":"EdDSA","kid":"hushbox-dev-admin","x":"5UK_KdbiPHqjbALUfCX-hQskgmFFShqwp_LTaFF9Q4I","d":"h8fBcfBOUkOF98WiWzzT-Ng7jV9sd_9WwKQ8Mjs1i9s"}',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
  },

  APP_VERSION: {
    to: [Destination.Backend],
    credential: {
      description:
        'The served application version string, published to the Worker by each deploy from the CI version job.',
      store: 'worker-only',
      replace: 'transparent',
      onLoss: 'mintedPerDeploy',
      family: 'deploy-minted',
      userVisible: 'none',
      coupledWith: [
        'APP_BUNDLE_CHECKSUM_IOS',
        'APP_BUNDLE_CHECKSUM_ANDROID',
        'APP_BUNDLE_CHECKSUM_ANDROID_DIRECT',
      ],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'dev-local',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('APP_VERSION'),
  },

  // Per-native-platform sha256 of the published OTA bundle, served on
  // `/updates/current` (selected by the X-HushBox-Platform header) so the
  // native client can hand it to Capgo's `download({ checksum })`, which
  // rejects a tampered/corrupt bundle before it is applied. OTA bundles are
  // built per platform (`builds/<platform>/<version>.zip`, distinct VITE_PLATFORM
  // → distinct sha256), so there is one binding per native platform.
  //
  // The production sha256 does not exist until each platform bundle is zipped
  // in CI: the "Upload mobile OTA bundles to R2" step computes it and the
  // deploy publishes it in the same request as APP_VERSION, exactly as
  // APP_VERSION's real value comes from the version job. No GitHub secret backs
  // the `secret()` marker — generate-env binds the key to that step's output.
  // Dev/CI carry no value, so the route omits the checksum.
  APP_BUNDLE_CHECKSUM_IOS: {
    to: [Destination.Backend],
    credential: {
      description:
        'sha256 of the published iOS OTA bundle, served on /updates/current for the download integrity check.',
      store: 'worker-only',
      replace: 'transparent',
      onLoss: 'mintedPerDeploy',
      family: 'deploy-minted',
      userVisible: 'none',
      coupledWith: [
        'APP_VERSION',
        'APP_BUNDLE_CHECKSUM_ANDROID',
        'APP_BUNDLE_CHECKSUM_ANDROID_DIRECT',
      ],
      leakImpact: 'nuisance',
    },
    [Mode.Production]: secret('APP_BUNDLE_CHECKSUM_IOS'),
  },
  APP_BUNDLE_CHECKSUM_ANDROID: {
    to: [Destination.Backend],
    credential: {
      description:
        'sha256 of the published Android (Play) OTA bundle, served on /updates/current for the download integrity check.',
      store: 'worker-only',
      replace: 'transparent',
      onLoss: 'mintedPerDeploy',
      family: 'deploy-minted',
      userVisible: 'none',
      coupledWith: ['APP_VERSION', 'APP_BUNDLE_CHECKSUM_IOS', 'APP_BUNDLE_CHECKSUM_ANDROID_DIRECT'],
      leakImpact: 'nuisance',
    },
    [Mode.Production]: secret('APP_BUNDLE_CHECKSUM_ANDROID'),
  },
  APP_BUNDLE_CHECKSUM_ANDROID_DIRECT: {
    to: [Destination.Backend],
    credential: {
      description:
        'sha256 of the published Android (direct-download) OTA bundle, served on /updates/current for the download integrity check.',
      store: 'worker-only',
      replace: 'transparent',
      onLoss: 'mintedPerDeploy',
      family: 'deploy-minted',
      userVisible: 'none',
      coupledWith: ['APP_VERSION', 'APP_BUNDLE_CHECKSUM_IOS', 'APP_BUNDLE_CHECKSUM_ANDROID'],
      leakImpact: 'nuisance',
    },
    [Mode.Production]: secret('APP_BUNDLE_CHECKSUM_ANDROID_DIRECT'),
  },

  // HMAC key the growth beacon derives its per-day visitor hash under. Keyed
  // rather than salted: an unkeyed digest over IPv4 times the common user
  // agents is reversible in hours, so a leaked set of hashes would be a set of
  // addresses. Nothing durable depends on it — the hashes live in Redis and in
  // no table, and how long a counting set holds one is `addUnderCeiling`'s to
  // say (`apps/api/src/slices/growth/domain/ceiling-gate.ts`) — so a
  // replacement costs at most a day's uniques counting twice.
  GROWTH_HASH_SECRET: {
    to: [Destination.Backend],
    credential: {
      description:
        'Derives the daily visitor hash the anonymous marketing counts are set memberships of; a holder can re-derive a day of hashes from addresses.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'random-secret',
      userVisible: 'none',
      leakImpact: 'expensive',
    },
    [Mode.Development]: 'dev-growth-hash-secret-32-bytes-min',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('GROWTH_HASH_SECRET'),
  },

  RESEND_API_KEY: {
    to: [Destination.Backend],
    credential: {
      description: 'Sends email as HushBox through Resend.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'resend-api-key',
      userVisible: 'none',
      leakImpact: 'severe',
    },
    [Mode.Production]: secret('RESEND_API_KEY'),
    // NOT in CI - email service uses console client when CI=true
  },

  // Signing secret for the Resend webhook receiver (Svix scheme, `whsec_`
  // prefix + standard base64). Dev/CI carry a fixed literal — never a real
  // secret — so tests can sign their own deliveries against the same
  // verification path production runs.
  RESEND_WEBHOOK_SECRET: {
    to: [Destination.Backend],
    credential: {
      description:
        'Verifies inbound Resend bounce and complaint webhooks; a holder can forge suppression events.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'resend-webhook-secret',
      userVisible: 'none',
      leakImpact: 'expensive',
    },
    [Mode.Development]: 'whsec_bmV3c2xldHRlci1kZXYtd2ViaG9vay1zZWNyZXQ=',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('RESEND_WEBHOOK_SECRET'),
  },

  // OpenRouter API key, consumed by the models-slice adapters
  // (createOpenRouterProvider). Production carries the production key.
  // CiVitest carries the spend-restricted key: CI records AI cassettes on a
  // miss (the first uncached call is a real charged call, replayed from the
  // cassette store thereafter), and the restricted key also backs the real-call
  // tests that `verify:evidence --require=openrouter-inference` asserts.
  // Missing-secret fail-fast comes from `generate:env --mode=ciVitest`, which
  // throws when a required secret is missing or empty; `verify:env` only checks
  // registry completeness, not secret values. Dev/E2E/CiE2E use the mock
  // literal — they ride cassette replay and failure fixtures only, so no secret
  // is required there.
  OPENROUTER_API_KEY: {
    to: [Destination.Backend],
    credential: {
      description:
        'Charges inference against the OpenRouter account: the production key in production, the spend-restricted key from the ci environment in CI.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'openrouter-key',
      userVisible: 'none',
      leakImpact: 'expensive',
    },
    [Mode.Development]: 'mock-openrouter-key',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: secret('OPENROUTER_API_KEY_RESTRICTED'),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('OPENROUTER_API_KEY_PRODUCTION'),
  },

  BRAVE_SEARCH_API_KEY: {
    to: [Destination.Backend],
    credential: {
      description:
        'Authenticates web-search requests to the Brave Search API: the production key in production, the restricted key from the ci environment in CI.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'brave-search-key',
      userVisible:
        'If Brave holds one key at a time, web-search turns answer without results from the old key being revoked until the deploy carrying the new one.',
      leakImpact: 'expensive',
    },
    [Mode.Development]: BRAVE_SEARCH_API_KEY_PLACEHOLDER,
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: secret('BRAVE_SEARCH_API_KEY_RESTRICTED'),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('BRAVE_SEARCH_API_KEY_PRODUCTION'),
  },

  FCM_PROJECT_ID: {
    to: [Destination.Backend],
    credential: {
      description: 'The Firebase project identifier for native push; not confidential.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'google-service-account',
      userVisible: 'none',
      coupledWith: ['FCM_SERVICE_ACCOUNT_JSON'],
      leakImpact: 'nuisance',
    },
    [Mode.Production]: secret('FCM_PROJECT_ID'),
    // NOT in dev/CI - push service uses console client
  },

  FCM_SERVICE_ACCOUNT_JSON: {
    to: [Destination.Backend],
    credential: {
      description:
        'Google service-account key that sends push messages to every registered native device.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'google-service-account',
      userVisible: 'none',
      coupledWith: ['FCM_PROJECT_ID'],
      leakImpact: 'severe',
    },
    [Mode.Production]: secret('FCM_SERVICE_ACCOUNT_JSON'),
    // NOT in dev/CI - push service uses console client
  },

  GOOGLE_SERVICES_JSON_BASE64: {
    to: [Destination.Scripts],
    credential: {
      description: 'The Firebase Android client configuration compiled into every shipped APK.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'google-service-account',
      userVisible: 'none',
      leakImpact: 'nuisance',
    },
    [Mode.Development]:
      'ewogICJwcm9qZWN0X2luZm8iOiB7CiAgICAicHJvamVjdF9udW1iZXIiOiAiMTAwNjQwMjYyNjAzOSIsCiAgICAicHJvamVjdF9pZCI6ICJodXNoYm94LWxvY2FsZGV2IiwKICAgICJzdG9yYWdlX2J1Y2tldCI6ICJodXNoYm94LWxvY2FsZGV2LmZpcmViYXNlc3RvcmFnZS5hcHAiCiAgfSwKICAiY2xpZW50IjogWwogICAgewogICAgICAiY2xpZW50X2luZm8iOiB7CiAgICAgICAgIm1vYmlsZXNka19hcHBfaWQiOiAiMToxMDA2NDAyNjI2MDM5OmFuZHJvaWQ6MjQ1MTRiMmRlMDEyY2MxNWEwY2VmMiIsCiAgICAgICAgImFuZHJvaWRfY2xpZW50X2luZm8iOiB7CiAgICAgICAgICAicGFja2FnZV9uYW1lIjogImFpLmh1c2hib3guYXBwIgogICAgICAgIH0KICAgICAgfSwKICAgICAgIm9hdXRoX2NsaWVudCI6IFtdLAogICAgICAiYXBpX2tleSI6IFsKICAgICAgICB7CiAgICAgICAgICAiY3VycmVudF9rZXkiOiAiQUl6YVN5QzlobVR2Rm95V05GZ0VYdDV3dW51TTlaSkRvSFdsYkVrIgogICAgICAgIH0KICAgICAgXSwKICAgICAgInNlcnZpY2VzIjogewogICAgICAgICJhcHBpbnZpdGVfc2VydmljZSI6IHsKICAgICAgICAgICJvdGhlcl9wbGF0Zm9ybV9vYXV0aF9jbGllbnQiOiBbXQogICAgICAgIH0KICAgICAgfQogICAgfQogIF0sCiAgImNvbmZpZ3VyYXRpb25fdmVyc2lvbiI6ICIxIgp9',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('GOOGLE_SERVICES_JSON_BASE64'),
  },

  // Web Push (RFC 8292 VAPID) application-server keypair for the in-house
  // browser push sender. The public key is published to browsers (also shipped
  // to the frontend as VITE_VAPID_PUBLIC_KEY for PushManager.subscribe); the
  // private key signs the per-request VAPID JWT. Dev/CI carry a committed
  // throwaway P-256 keypair — harmless, since dev/CI push only ever reaches the
  // in-process mock sender, never a real push service. Production keys are
  // Workers secrets minted out-of-band. Base64url: public = 65-byte
  // uncompressed point, private = 32-byte scalar (classic web-push wire form).
  VAPID_PUBLIC_KEY: {
    to: [Destination.Backend],
    credential: {
      description:
        'Public half of the Web Push application-server keypair, bound into every live browser subscription.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'vapid-keypair',
      userVisible: "pushes between the swap and each browser's next load are lost",
      coupledWith: ['VAPID_PRIVATE_KEY', 'VITE_VAPID_PUBLIC_KEY'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]:
      'BOeIadxzr8jCEiJstuK2__fGtYo6wWP0HMZDdYl-RWBXoSB9O1Bs4Dd4gPtm5WijJcYxrmH-i1QTCTzaj9xJ4tE',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('VAPID_PUBLIC_KEY'),
  },

  VAPID_PRIVATE_KEY: {
    to: [Destination.Backend],
    credential: {
      description: 'Signs the per-request VAPID JWT for browser push.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'vapid-keypair',
      userVisible: "pushes between the swap and each browser's next load are lost",
      coupledWith: ['VAPID_PUBLIC_KEY', 'VITE_VAPID_PUBLIC_KEY'],
      leakImpact: 'severe',
    },
    [Mode.Development]: 'SQ6hnT9IQ-46JeC7tl_zN_tJjH0v76csKdFBGcCYTx0',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('VAPID_PRIVATE_KEY'),
  },

  // RFC 8292 §2.1 `sub`: a mailto:/https: URI the push service can use to
  // contact the sender. Not a secret; identical across modes.
  VAPID_SUBJECT: {
    to: [Destination.Backend],
    [Mode.Development]: 'mailto:notifications@hushbox.ai',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'mailto:notifications@hushbox.ai',
  },

  // The VAPID public key, shipped to the browser for PushManager.subscribe.
  // Same value as VAPID_PUBLIC_KEY; a separate VITE_ entry so it reaches the
  // frontend bundle. Public by design — safe to expose.
  //
  // Held at repository level because the jobs that compile it into a bundle run
  // under more than one environment, and an environment-held value resolves to
  // the empty string in every other environment.
  VITE_VAPID_PUBLIC_KEY: {
    to: [Destination.Frontend],
    credential: {
      description: 'The VAPID public key compiled into the frontend for PushManager.subscribe.',
      store: 'github:repository',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'vapid-keypair',
      userVisible: "pushes between the swap and each browser's next load are lost",
      coupledWith: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]:
      'BOeIadxzr8jCEiJstuK2__fGtYo6wWP0HMZDdYl-RWBXoSB9O1Bs4Dd4gPtm5WijJcYxrmH-i1QTCTzaj9xJ4tE',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('VITE_VAPID_PUBLIC_KEY'),
  },

  // HMAC key that derives the per-conversation push collapse alias (the
  // FCM collapse_key / notification tag and the Web Push Topic header). The
  // alias replaces the raw conversationId in every push-service-visible header
  // so the push services never see it. Needed in every mode because the alias
  // is stamped on all sends, including the dev/CI mock — hence a committed
  // throwaway value here (never used to protect anything; the raw id is not a
  // secret to FCM, which already sees it in the data payload). Production is a
  // Workers secret minted out-of-band.
  NOTIFICATION_TAG_SECRET: {
    to: [Destination.Backend],
    credential: {
      description:
        'HMAC key deriving the per-conversation push collapse alias so push services never see a raw conversation id.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'random-secret',
      userVisible: 'none',
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'NoCxqgOg_DdFAxJ9q7q4Sv7QGroKx5qGWtPO88qV14U',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('NOTIFICATION_TAG_SECRET'),
  },

  HELCIM_API_TOKEN: {
    to: [Destination.Backend],
    credential: {
      description:
        'Charges cards and reads transaction history on the Helcim merchant account; the sandbox token from the ci environment in CI end-to-end runs.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'helcim-credentials',
      userVisible: 'none',
      coupledWith: ['HELCIM_WEBHOOK_VERIFIER'],
      leakImpact: 'severe',
    },
    [Mode.CiE2E]: secret('HELCIM_API_TOKEN_SANDBOX'),
    [Mode.Production]: secret('HELCIM_API_TOKEN_PRODUCTION'),
    // NOT in ciVitest or e2e - only CI e2e and production need real Helcim
  },

  // Linear read-only API key for the public /roadmap page. One key used in
  // both CI integration tests (catches Linear GraphQL schema breaks) and
  // production. NOT in Development / E2E / CiE2E — those modes use the mock
  // Linear client per the factory at apps/api/src/services/linear/index.ts.
  // A single GitHub secret name serves both CiVitest and Production because
  // there is no permission difference between CI and prod for a read-only key.
  LINEAR_API_KEY_READ: {
    to: [Destination.Backend],
    credential: {
      description: 'Read-only access to the Linear workspace, backing the public roadmap page.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'linear-key',
      userVisible: 'none',
      leakImpact: 'expensive',
    },
    [Mode.CiVitest]: secret('LINEAR_API_KEY_READ'),
    [Mode.Production]: secret('LINEAR_API_KEY_READ'),
  },

  // FCM credentials for the CI-only live send test, deliberately SEPARATE from
  // the production FCM_PROJECT_ID / FCM_SERVICE_ACCOUNT_JSON so the production
  // credential is never something CI reads. The service account behind these
  // holds exactly `cloudmessaging.messages.create`, and the test it feeds sends
  // `validate_only`, so nothing reaches a device. CiVitest only: no Development
  // entry (local dev never calls Google), and production has its own vars.
  FCM_PROJECT_ID_CI: {
    to: [Destination.Backend],
    credential: {
      description:
        'The Firebase project identifier for the CI-only validate-only send test; not confidential.',
      store: 'github:ci',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'google-service-account',
      userVisible: 'none',
      coupledWith: ['FCM_SERVICE_ACCOUNT_JSON_CI'],
      leakImpact: 'nuisance',
    },
    [Mode.CiVitest]: secret('FCM_PROJECT_ID_CI'),
  },

  FCM_SERVICE_ACCOUNT_JSON_CI: {
    to: [Destination.Backend],
    credential: {
      description:
        'A separate service-account key holding only message creation, which can deliver to a device; CI reaches none because the one send it makes is validate-only.',
      store: 'github:ci',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'google-service-account',
      userVisible: 'none',
      coupledWith: ['FCM_PROJECT_ID_CI'],
      leakImpact: 'nuisance',
    },
    [Mode.CiVitest]: secret('FCM_SERVICE_ACCOUNT_JSON_CI'),
  },

  HELCIM_WEBHOOK_VERIFIER: {
    to: [Destination.Backend],
    credential: {
      description:
        'Verifies inbound Helcim payment webhooks; a holder can forge payment events but cannot mint credit.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'helcim-credentials',
      userVisible: 'none',
      coupledWith: ['HELCIM_API_TOKEN'],
      leakImpact: 'expensive',
    },
    [Mode.Development]: 'bW9jay13ZWJob29rLXZlcmlmaWVyLXNlY3JldC0zMmI=', // Mock verifier for local webhook testing
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: secret('HELCIM_WEBHOOK_VERIFIER_SANDBOX'),
    [Mode.Production]: secret('HELCIM_WEBHOOK_VERIFIER_PRODUCTION'),
  },

  // R2 media storage — single S3 codepath for both reads and writes.
  // PUTs/DELETEs/LIST/presigned GET URLs all go through aws4fetch using these
  // R2 S3 API credentials. No Workers binding.
  R2_S3_ENDPOINT: {
    to: [Destination.Backend],
    credential: {
      description: 'The account-scoped R2 S3 API endpoint address; not confidential.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'r2-token',
      userVisible: 'none',
      coupledWith: ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'http://minioapi.localhost',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('R2_S3_ENDPOINT'),
  },

  R2_ACCESS_KEY_ID: {
    to: [Destination.Backend],
    credential: {
      description:
        'Object-scoped R2 access key id for the media bucket; pairs with the secret key.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'r2-token',
      userVisible: 'none',
      coupledWith: ['R2_S3_ENDPOINT', 'R2_SECRET_ACCESS_KEY'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'minioadmin',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('R2_ACCESS_KEY_ID'),
  },

  R2_SECRET_ACCESS_KEY: {
    to: [Destination.Backend],
    credential: {
      description:
        'Reads, writes and deletes every object in the media bucket and mints presigned URLs.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'r2-token',
      userVisible:
        'media reads and uploads fail from the token change until the deploy carrying the new value completes',
      coupledWith: ['R2_S3_ENDPOINT', 'R2_ACCESS_KEY_ID'],
      leakImpact: 'severe',
    },
    [Mode.Development]: 'minioadmin',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('R2_SECRET_ACCESS_KEY'),
  },

  R2_BUCKET_MEDIA: {
    to: [Destination.Backend],
    // Scripts as well as the Worker: the bring-up creates the bucket this names
    // and the compose file interpolates it, and both read the scripts file.
    [Mode.Development]: {
      value: STACK_BUCKET_MARKER,
      to: [Destination.Backend, Destination.Scripts],
    },
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'hushbox-media',
  },

  // The encrypted backup repository on Backblaze B2. The hourly backup
  // workflow writes it from its own environment; the Worker only reads it, on
  // the cron auditor that pages when the repository stops growing or the
  // bucket's retention rule drifts from the published ceiling. Endpoint and
  // region are environment-provided because a B2 key is minted per region and
  // the account's is not this repository's to state.
  //
  // Those two are held at repository level rather than in one GitHub
  // environment, because two environments read them: the deploy publishes them
  // to the Worker from `production`, and the hourly backup run reads them from
  // `backup`. An environment secret is unreadable from any other environment,
  // so naming one environment here would mean the same address set twice, in
  // two places that must agree and that nothing compares.
  BACKUP_B2_S3_ENDPOINT: {
    to: [Destination.Backend],
    credential: {
      description:
        'The region-scoped Backblaze B2 S3 API endpoint address for the backup bucket; an address, not a grant.',
      store: 'github:repository',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'backblaze-key',
      userVisible: 'none',
      coupledWith: ['BACKUP_B2_REGION', 'BACKUP_B2_AUDITOR_KEY_ID', 'BACKUP_B2_AUDITOR_KEY'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'http://minioapi.localhost',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('BACKUP_B2_S3_ENDPOINT'),
  },

  BACKUP_B2_REGION: {
    to: [Destination.Backend],
    credential: {
      description:
        'The Backblaze B2 region the backup bucket lives in, which the request signature is scoped to; an address, not a grant.',
      store: 'github:repository',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'backblaze-key',
      userVisible: 'none',
      coupledWith: ['BACKUP_B2_S3_ENDPOINT', 'BACKUP_B2_AUDITOR_KEY_ID', 'BACKUP_B2_AUDITOR_KEY'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'us-east-1',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('BACKUP_B2_REGION'),
  },

  BACKUP_B2_BUCKET: {
    to: [Destination.Backend],
    [Mode.Development]: 'hushbox-backup-dev',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'hushbox-backup',
  },

  // The key prefix the repository occupies inside the bucket. The lifecycle
  // rule the auditor checks is the one covering this prefix, so a repository
  // moved here without the rule following is exactly what that check catches.
  BACKUP_REPO_ROOT: {
    to: [Destination.Backend],
    [Mode.Development]: 'repository',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: ref(Mode.Development),
  },

  BACKUP_B2_AUDITOR_KEY_ID: {
    to: [Destination.Backend],
    credential: {
      description:
        'The Backblaze B2 application key id the Worker cron auditor lists the backup repository with; pairs with the key.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'backblaze-key',
      userVisible: 'none',
      coupledWith: ['BACKUP_B2_S3_ENDPOINT', 'BACKUP_B2_REGION', 'BACKUP_B2_AUDITOR_KEY'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'minioadmin',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('BACKUP_B2_AUDITOR_KEY_ID'),
  },

  BACKUP_B2_AUDITOR_KEY: {
    to: [Destination.Backend],
    credential: {
      description:
        'Lists the encrypted backup repository and does nothing else: listBuckets and listFiles, so it can neither write, delete, nor fetch an object body. The Worker cron auditor issues two bucket-level GETs and never downloads a snapshot, so a read capability would grant it nothing while turning a stolen key into a download of the whole encrypted corpus at our egress expense. A thief learns how many objects the repository holds and how large they are, which is what the backup schedule already implies.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'backblaze-key',
      userVisible: 'none',
      coupledWith: ['BACKUP_B2_S3_ENDPOINT', 'BACKUP_B2_REGION', 'BACKUP_B2_AUDITOR_KEY_ID'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'minioadmin',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('BACKUP_B2_AUDITOR_KEY'),
  },

  // What the hourly backup run reads. The workflow's own credentials are
  // production values the backup GitHub environment holds; every value below is
  // the local stand-in a `pnpm backup` against the local stack runs on, so the
  // one command serves both. Scripts-destined: the orchestrator is the only
  // reader, and none of these reaches the Worker.
  BACKUP_R2_S3_ENDPOINT: {
    to: [Destination.Scripts],
    credential: {
      description:
        'The account-scoped R2 S3 API endpoint the backup run reads the source buckets at; an address, not a grant. Held apart from R2_S3_ENDPOINT because that one lives in the production environment, which the backup environment cannot read.',
      store: 'github:backup',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'r2-token',
      userVisible: 'none',
      coupledWith: ['BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_SECRET_ACCESS_KEY'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'http://minioapi.localhost',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('BACKUP_R2_S3_ENDPOINT'),
  },

  BACKUP_R2_REGION: {
    to: [Destination.Scripts],
    [Mode.Development]: 'us-east-1',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    // R2's S3 API answers one region name, which every other client in this
    // repository signs against too.
    [Mode.Production]: 'auto',
  },

  // The buckets snapshotted straight from object storage. Media asks for the
  // stack's own bucket, so a backup run reads the objects the stack it was
  // invoked under actually wrote; app builds and model weights are fixed,
  // because no stack writes either of its own.
  BACKUP_SOURCE_BUCKET_MEDIA: {
    to: [Destination.Scripts],
    [Mode.Development]: STACK_BUCKET_MARKER,
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'hushbox-media',
  },

  BACKUP_SOURCE_BUCKET_APP_BUILDS: {
    to: [Destination.Scripts],
    [Mode.Development]: 'hushbox-app-builds-dev',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'hushbox-app-builds',
  },

  BACKUP_SOURCE_BUCKET_MODEL_WEIGHTS: {
    to: [Destination.Scripts],
    [Mode.Development]: 'hushbox-model-weights-dev',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'hushbox-model-weights',
  },

  // The read-only object-storage pair the sources are listed and read with.
  // Locally the emulator holds one account, so this is the same pair every
  // other client presents.
  BACKUP_R2_ACCESS_KEY_ID: {
    to: [Destination.Scripts],
    credential: {
      description:
        'The R2 application key id the backup run lists and reads the three source buckets with; pairs with the key.',
      store: 'github:backup',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'r2-token',
      userVisible: 'none',
      coupledWith: ['BACKUP_R2_S3_ENDPOINT', 'BACKUP_R2_SECRET_ACCESS_KEY'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'minioadmin',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('BACKUP_R2_ACCESS_KEY_ID'),
  },

  BACKUP_R2_SECRET_ACCESS_KEY: {
    to: [Destination.Scripts],
    credential: {
      description:
        'Reads the three source buckets and does nothing else: a read-only R2 token, so a stolen backup key can neither write nor delete the objects it copies. What it grants is what the objects themselves grant, which is ciphertext.',
      store: 'github:backup',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'r2-token',
      userVisible: 'none',
      coupledWith: ['BACKUP_R2_S3_ENDPOINT', 'BACKUP_R2_ACCESS_KEY_ID'],
      leakImpact: 'severe',
    },
    [Mode.Development]: 'minioadmin',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('BACKUP_R2_SECRET_ACCESS_KEY'),
  },

  // The pair the repository itself is written with, distinct from
  // `BACKUP_B2_AUDITOR_KEY_ID` and `BACKUP_B2_AUDITOR_KEY`: this pair writes, that
  // one only lists.
  BACKUP_B2_KEY_ID: {
    to: [Destination.Scripts],
    credential: {
      description:
        'The Backblaze B2 application key id the backup run writes the repository with; pairs with the key.',
      store: 'github:backup',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'backblaze-key',
      userVisible: 'none',
      coupledWith: ['BACKUP_B2_KEY'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'minioadmin',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('B2_ACCOUNT_ID'),
  },

  BACKUP_B2_KEY: {
    to: [Destination.Scripts],
    credential: {
      description:
        'Writes the encrypted backup repository. Minted without deleteFiles, so prune only hides a version and the bucket lifecycle rule is the one thing that erases anything: a stolen key cannot destroy a version outright, but it can hide every version in the bucket and overwrite every one, and the lifecycle rule then erases what it hid. Recovery is that lifecycle window, and the staleness auditor is what detects the hiding. Distinct from the auditor pair, which only lists.',
      store: 'github:backup',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'backblaze-key',
      userVisible: 'none',
      coupledWith: ['BACKUP_B2_KEY_ID'],
      leakImpact: 'severe',
    },
    [Mode.Development]: 'minioadmin',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('B2_ACCOUNT_KEY'),
  },

  // The repository's encryption password. A local repository holds a local
  // stack's data and is thrown away with the emulator's volume, so its password
  // is a fixed stand-in; the production value is the one credential whose loss
  // makes every backup unreadable.
  BACKUP_REPOSITORY_PASSWORD: {
    to: [Destination.Scripts],
    credential: {
      description:
        'Encrypts the backup repository, and is the only thing that decrypts it: lost, every backup ever written is unreadable, which is why a copy is escrowed. Alone it opens nothing, since reading the repository also needs the bucket; held beside the corpus it opens every database row and every stored object. Replacing it is a key added to the repository and the new value set, and every backup already written stays readable.',
      store: 'github:backup',
      replace: 'transparent',
      onLoss: 'restoreFromCopy',
      family: 'random-secret',
      userVisible: 'none',
      leakImpact: 'severe',
    },
    [Mode.Development]: 'local-backup-repository',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('BACKUP_REPOSITORY_PASSWORD'),
  },

  // Two connections rather than one, because the dump takes both halves from
  // the same transaction snapshot and locally no single endpoint serves both:
  // the driver that exports and holds the snapshot speaks WebSocket through the
  // stack's proxy, while the containerised `pg_dump` speaks the wire protocol
  // straight at Postgres. On Neon one direct endpoint answers both, so the two
  // production values are the same connection.
  BACKUP_DATABASE_URL: {
    to: [Destination.Scripts],
    credential: {
      description:
        'The connection the dump is taken over. It must name the direct, unpooled Neon host: the dump exports a transaction snapshot and hands it to a second session, which a pooled endpoint routes to a different backend that cannot see it.',
      store: 'github:backup',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'neon-role-password',
      userVisible: 'none',
      coupledWith: ['BACKUP_SNAPSHOT_DATABASE_URL'],
      leakImpact: 'severe',
    },
    [Mode.Development]: `postgresql://hushbox_app:hushbox_app@postgres.localhost/${STACK_DATABASE_MARKER}`,
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('BACKUP_DATABASE_URL'),
  },

  BACKUP_SNAPSHOT_DATABASE_URL: {
    to: [Destination.Scripts],
    credential: {
      description:
        'The connection the session exporting the dump snapshot makes. One GitHub secret answers both halves in production, where a single direct Neon endpoint serves the driver and pg_dump alike; locally they are two endpoints of one database.',
      store: 'github:backup',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'neon-role-password',
      userVisible: 'none',
      coupledWith: ['BACKUP_DATABASE_URL'],
      leakImpact: 'severe',
    },
    [Mode.Development]: `postgres://hushbox_app:hushbox_app@neon.localhost/${STACK_DATABASE_MARKER}`,
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('BACKUP_DATABASE_URL'),
  },

  // Which Telemetry-port sinks the API composes per request. Per-mode
  // registry values are the mechanism (no code branches on NODE_ENV):
  // dev/test/E2E modes compose the console adapter only; production composes
  // every bound sink. The Worker composition seam fails fast on a missing or
  // unknown value — there is no default sink list. The Durable Object seam
  // degrades to console-only instead: telemetry must never outrank money or
  // persistence there.
  TELEMETRY_SINKS: {
    to: [Destination.Backend],
    [Mode.Development]: 'console',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'console,sentry',
  },

  // Sentry DSN for the unexpected-error telemetry channel. Dev/test/E2E
  // disable Sentry with an EXPLICIT empty value (the sentry sink is not in
  // TELEMETRY_SINKS there, and the registry never relies on a fallback);
  // production resolves the secret, and the Worker composition seam fails
  // fast when the sentry sink is requested without a DSN.
  SENTRY_DSN: {
    to: [Destination.Backend],
    credential: {
      description: 'Write-only ingest endpoint for backend error events into the Sentry project.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'sentry-dsn',
      userVisible: 'none',
      leakImpact: 'nuisance',
    },
    [Mode.Development]: '',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('SENTRY_DSN'),
  },

  // R2 bucket-admin S3 credentials — separate token from the object-scoped
  // runtime credentials above. Only bucket-config ops (e.g. PutBucketCors in
  // ops/r2/configure-cors.ts) need this; the runtime Worker must NOT hold it,
  // so these go to Destination.Ops (ops runner env blocks only), never into the
  // API deploy's secrets file. Locally the MinIO root account is admin-capable,
  // so dev/CI reuse the same minioadmin defaults as the object credentials.
  R2_ADMIN_ACCESS_KEY_ID: {
    to: [Destination.Ops],
    credential: {
      description: 'Bucket-admin R2 access key id, held by the ops runner alone.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'r2-token',
      userVisible: 'none',
      coupledWith: ['R2_ADMIN_SECRET_ACCESS_KEY'],
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'minioadmin',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('R2_ADMIN_ACCESS_KEY_ID'),
  },

  R2_ADMIN_SECRET_ACCESS_KEY: {
    to: [Destination.Ops],
    credential: {
      description:
        'Bucket-configuration authority on R2 beyond object access, held by the ops runner alone.',
      store: 'github:production',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'r2-token',
      userVisible: 'none',
      coupledWith: ['R2_ADMIN_ACCESS_KEY_ID'],
      leakImpact: 'severe',
    },
    [Mode.Development]: 'minioadmin',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('R2_ADMIN_SECRET_ACCESS_KEY'),
  },

  // Frontend only
  VITE_API_URL: {
    to: [Destination.Frontend],
    [Mode.Development]: 'http://api.localhost',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://api.hushbox.ai',
  },

  // Held at repository level because the jobs that compile it into a bundle run
  // under more than one environment, and an environment-held value resolves to
  // the empty string in every other environment.
  VITE_HELCIM_JS_TOKEN: {
    to: [Destination.Frontend],
    credential: {
      description:
        'The publishable Helcim card-tokenisation token, served like every client-visible value from every origin that ships a client bundle; abuse of its card-submission path is the reason to replace it.',
      store: 'github:repository',
      replace: 'transparent',
      onLoss: 'reissueAtVendor',
      family: 'helcim-credentials',
      userVisible:
        'a native client card form works again once it takes the next over-the-air update',
      leakImpact: 'expensive',
    },
    // Non-secret placeholder for the mock-tokenizer modes (isLocalDev): the mock
    // path ignores the token's value, but the var must resolve to a string so the
    // form's fail-fast (absent ⟹ deploy misconfiguration) never fires under vitest,
    // whose MODE='test' makes isLocalDev false and thus reads the var.
    [Mode.Development]: 'mock-helcim-js-token',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: secret('VITE_HELCIM_JS_TOKEN_SANDBOX'),
    [Mode.Production]: secret('VITE_HELCIM_JS_TOKEN_PRODUCTION'),
    // NOT in e2e - only CI e2e and production need real Helcim
  },

  VITE_PLATFORM: {
    to: [Destination.Frontend],
    [Mode.Development]: 'web',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'web', // Mobile builds override via CI env
  },

  // The version the client bundle reports, minted per deploy by the CI version
  // job exactly as APP_VERSION is: no GitHub secret backs the marker, and each
  // build step binds the job's output under this name. A literal here would be
  // written verbatim into the production file and baked by a build that exits
  // zero, which is why the production value is a marker the generation refuses
  // to resolve from nothing. The store says only that nothing stored holds the
  // value — this one is baked into the bundle at build time and reaches no
  // Worker.
  VITE_APP_VERSION: {
    to: [Destination.Frontend],
    credential: {
      description:
        'The application version string the client bundle reports, baked in at build time from the CI version job.',
      store: 'worker-only',
      replace: 'transparent',
      onLoss: 'mintedPerDeploy',
      family: 'deploy-minted',
      userVisible: 'none',
      leakImpact: 'nuisance',
    },
    [Mode.Development]: 'dev-local',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('VITE_APP_VERSION'),
  },

  // The effective date each published legal document renders, derived per build
  // from the release tags by `scripts/legal-effective-dates.ts` and bound here
  // exactly as VITE_APP_VERSION is. The production value is a marker for that
  // entry's reason and one more: a date written here would be a date a person
  // typed, and the whole design exists so that nobody types one — the revision
  // integer beside each document's copy is the only human input. The store says
  // only that nothing stored holds the value; each build mints it.
  VITE_PRIVACY_POLICY_EFFECTIVE_DATE: {
    to: [Destination.Frontend],
    credential: {
      description:
        "The Privacy Policy's effective date the client bundle renders, derived at build time from the release tag that first shipped the document's current revision.",
      store: 'worker-only',
      replace: 'transparent',
      onLoss: 'mintedPerDeploy',
      family: 'deploy-minted',
      userVisible: 'none',
      leakImpact: 'nuisance',
    },
    [Mode.Development]: UNDERIVED_EFFECTIVE_DATE,
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('VITE_PRIVACY_POLICY_EFFECTIVE_DATE'),
  },

  VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE: {
    to: [Destination.Frontend],
    credential: {
      description:
        "The Terms of Service's effective date the client bundle renders, derived at build time from the release tag that first shipped the document's current revision.",
      store: 'worker-only',
      replace: 'transparent',
      onLoss: 'mintedPerDeploy',
      family: 'deploy-minted',
      userVisible: 'none',
      leakImpact: 'nuisance',
    },
    [Mode.Development]: UNDERIVED_EFFECTIVE_DATE,
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE'),
  },

  VITE_CI: {
    to: [Destination.Frontend],
    [Mode.CiVitest]: ENV_FLAG_TRUE,
    [Mode.CiE2E]: ENV_FLAG_TRUE,
    // NOT in E2E — local e2e is not CI
  },

  VITE_E2E: {
    to: [Destination.Frontend],
    [Mode.E2E]: ENV_FLAG_TRUE,
    [Mode.CiE2E]: ref(Mode.E2E),
  },

  // Drizzle Studio's hosted UI is served from Drizzle's own origin and connects
  // back to a local websocket server, so this URL must be routable from the
  // browser. Dev-only — production/CI builds hide the link.
  VITE_DRIZZLE_STUDIO_URL: {
    to: [Destination.Frontend],
    [Mode.Development]: 'http://studio.localhost',
    [Mode.E2E]: ref(Mode.Development),
  },

  // Admin SPA dev server URL for the web app's dev-only sidebar link. Dev-only
  // — production admin lives on
  // admin.hushbox.ai behind Cloudflare Access, never linked from the product.
  VITE_ADMIN_URL: {
    to: [Destination.Frontend],
    [Mode.Development]: 'http://admin.localhost',
    [Mode.E2E]: ref(Mode.Development),
  },

  // Crawler-view dev-tool origin for the dev-only "crawler-eye" badge on the
  // web app. Development-only:
  // crawler-view is a local tooling server that is never deployed, and the badge
  // is gated on `env.isDevServer` (false under E2E/vitest/CI/production), so no
  // other mode needs a value — an E2E value would be baked into that dev-mode
  // build yet never read, and its `/api/crawl` fetch would trip the app CSP.
  VITE_CRAWLER_VIEW_URL: {
    to: [Destination.Frontend],
    [Mode.Development]: 'http://crawlerview.localhost',
  },

  // Product web-app origin for the admin SPA's admin→chat link. Defined for
  // every mode, production included, because that link must work in prod
  // (unlike the dev-only VITE_ADMIN_URL). Mirrors FRONTEND_URL's mode set.
  VITE_WEB_URL: {
    to: [Destination.Frontend],
    [Mode.Development]: 'http://vite.localhost',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://hushbox.ai',
  },

  // Scripts only
  MIGRATION_DATABASE_URL: {
    to: [Destination.Scripts],
    [Mode.Development]: `postgresql://hushbox_app:hushbox_app@postgres.localhost/${STACK_DATABASE_MARKER}`,
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
  },

  // Whether the E2E reporter attaches its inspector client to the API isolate
  // and samples the heap (`scripts/e2e-reporter.ts`). `off` is what makes the
  // probe's own cost measurable: the probe is the only reader of that heap, so
  // nothing else can score a run without it. It lives here rather than in a
  // shell because the generated env files load with `override: true`, so this
  // value is the one the reporter sees whatever the environment says; changing
  // arms is a registry change plus `pnpm generate:env`, which leaves the arm on
  // record. Not set in production: no stack runs there, and no reporter with it.
  E2E_HEAP_PROBE: {
    to: [Destination.Scripts],
    [Mode.Development]: 'on',
    [Mode.Test]: ref(Mode.Development),
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
  },
} as const satisfies Record<string, VariableConfig>;

// Zod schemas for validation
export const backendEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  API_URL: z.url(),
  FRONTEND_URL: z.url(),
  MARKETING_URL: z.url(),
  FRONTEND_PREVIEW_URL: z.url().optional(),
  ADMIN_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  APP_VERSION: z.string().min(1),
  GROWTH_HASH_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  HELCIM_API_TOKEN: z.string().optional(),
  HELCIM_WEBHOOK_VERIFIER: z.string().optional(),
  LINEAR_API_KEY_READ: z.string().min(1).optional(),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
  FCM_PROJECT_ID_CI: z.string().min(1).optional(),
  FCM_SERVICE_ACCOUNT_JSON_CI: z.string().min(1).optional(),
  // Web Push VAPID keys. Optional in the schema because dev/CI satisfy them
  // from envConfig's committed throwaway keypair and the real webpush sender is
  // only constructed in production (dev/CI push goes to the mock); the
  // production fail-fast lives where the sender is wired.
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().min(1).optional(),
  // Required in every mode (no fallback): the push collapse-alias HMAC key is
  // stamped on all sends including the dev/CI mock, so envConfig supplies a
  // value for each mode and absence is a bad bootstrap that must fail fast.
  NOTIFICATION_TAG_SECRET: z.string().min(1),
  // Redis
  UPSTASH_REDIS_REST_URL: z.url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  // Auth secrets
  OPAQUE_KEK: z.string().min(32),
  TOTP_ENCRYPTION_SECRET: z.string().min(32),
  ENUMERATION_DECOY_SECRET: z.string().min(32),
  IRON_SESSION_SECRET: z.string().min(32),
  // Admin plane (Cloudflare Access). Optional here because only the admin
  // JWT stage consumes them, with its own fail-fast at first admin-classed
  // request; CF_ACCESS_DEV_PRIVATE_JWK exists in dev/CI modes only.
  CF_ACCESS_TEAM_DOMAIN: z.string().min(1).optional(),
  CF_ACCESS_AUD: z.string().min(1).optional(),
  ADMIN_ACTOR_ALLOWLIST: z.string().min(1).optional(),
  ADMIN_ROLE_MAP: z.string().min(1).optional(),
  GROWTH_READER_DATABASE_URL: z.string().min(1).optional(),
  CF_ACCESS_DEV_PRIVATE_JWK: z.string().min(1).optional(),
  ADMIN_SQL_PANEL_DATABASE_URL: z.string().min(1).optional(),
  CLOUDFLARE_ACCESS_LOG_API_TOKEN: z.string().min(1).optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
  // R2 media storage (S3 API credentials — full read/write scope).
  //
  // These four fields are `.optional()` here because dev and CI satisfy them
  // automatically from `envConfig`'s mode-specific defaults pointing at the
  // local MinIO emulator — engineers do not (and should not) set them in
  // their personal env files.
  //
  // In production they are REQUIRED. The runtime fail-fast guard is
  // `requireBinding` in `apps/api/src/slices/media/adapters/storage-factory.ts`,
  // which throws a clear error when any of these four env vars is missing or
  // empty when the storage client is constructed. Keeping the schema permissive
  // here while delegating the production assertion to the consumer module
  // avoids a second source of truth and keeps dev/CI bootstrap clean.
  R2_S3_ENDPOINT: z.url().optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET_MEDIA: z.string().min(1).optional(),
});
