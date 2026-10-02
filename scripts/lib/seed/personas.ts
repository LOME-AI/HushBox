/**
 * Persona roster for local-dev and E2E seeding — pure data plus the derivation
 * helpers the orchestrator composes with. No DB, no infra: the seed
 * orchestrator feeds these records to the factories.
 *
 * Money note: the legacy seed expressed persona balances and payment amounts as
 * 8-decimal dollar strings. This module expresses every monetary value as
 * integer nano-USD (`bigint`) — the money unit of the redesigned system — via
 * exact integer conversion (`usdDecimalToNanoUsd`); no floating point is used.
 */

// The persona-pool size is derived in worker-count.ts as the max of the workers
// that actually run locally (resolveLocalWorkerCount) and CI's fixed count, so
// it always covers whatever worker count runs. Imported for the internal
// derivations below and re-exported so existing importers keep pulling it from
// `seed/personas` unchanged.
import { DEV_EMAIL_DOMAIN, TEST_EMAIL_DOMAIN } from '@hushbox/shared';
import { E2E_PROJECT_NAMES, PROJECT_CODE, type E2EProjectName } from '../playwright/projects.js';
import { E2E_WORKER_POOL_SIZE } from '../playwright/worker-count.js';

// The frozen name → UUID hash lives in one module; re-exported here so persona
// callers get it from `seed/personas` without a second copy (its pinned-value
// test guards the algorithm).
export { seedUUID } from './uuid.js';
export { E2E_WORKER_POOL_SIZE } from '../playwright/worker-count.js';

// The project roster is one registry (`../playwright/projects.ts`) that the Playwright
// config derives from too; re-exported here so persona callers keep importing it
// from `seed/personas` unchanged.
export { E2E_PROJECT_NAMES, PROJECT_CODE, type E2EProjectName } from '../playwright/projects.js';

/** Nano-USD (1e-9 USD) per whole USD. */
const NANO_USD_PER_USD = 1_000_000_000n;

/**
 * Exact integer conversion of a decimal dollar string (e.g. `'10000.00000000'`,
 * `'0.20000000'`, `'5'`) to nano-USD `bigint`. Accepts at most 9 fractional
 * digits (nano precision). No floating point — the fractional digits are padded
 * to 9 and combined with bigint math. Throws on malformed input (fail-fast).
 */
export function usdDecimalToNanoUsd(usd: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(usd.trim());
  if (!match) {
    throw new Error(`usdDecimalToNanoUsd: not a decimal dollar string: "${usd}"`);
  }
  const [, sign, whole, frac = ''] = match;
  if (frac.length > 9) {
    throw new Error(`usdDecimalToNanoUsd: more than 9 fractional digits: "${usd}"`);
  }
  /* v8 ignore next -- the regex's required (\d+) group guarantees `whole` is always present */
  const magnitude = BigInt(whole ?? '0') * NANO_USD_PER_USD + BigInt(frac.padEnd(9, '0'));
  return sign === '-' ? -magnitude : magnitude;
}

/** Nano-USD `bigint` → decimal USD string (up to 9 places), for `setWalletBalance`. */
export function nanoUsdToDecimalString(nanoUsd: bigint): string {
  const negative = nanoUsd < 0n;
  const magnitude = negative ? -nanoUsd : nanoUsd;
  const whole = magnitude / 1_000_000_000n;
  const fraction = (magnitude % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  const value = fraction.length > 0 ? `${whole.toString()}.${fraction}` : whole.toString();
  return negative ? `-${value}` : value;
}

export function devEmail(name: string): string {
  return `${name}@${DEV_EMAIL_DOMAIN}`;
}

export function testEmail(name: string): string {
  return `${name}@${TEST_EMAIL_DOMAIN}`;
}

/** A local-dev persona (rich sample data, deterministic identity). */
export interface DevPersona {
  name: string;
  displayName: string;
  emailVerified: boolean;
  hasSampleData: boolean;
  /**
   * How many conversations the bulk sample-data generator produces for this
   * persona. Only consulted when {@link DevPersona.hasSampleData} is set; the
   * generator is skipped entirely otherwise, so this value is inert for
   * non-sample personas.
   */
  sampleConversationCount: number;
  /** Starting purchased-wallet balance in nano-USD. */
  balanceNanoUsd: bigint;
}

export const DEV_PERSONAS: DevPersona[] = [
  {
    name: 'alice',
    displayName: 'Sarah Chen',
    emailVerified: true,
    hasSampleData: true,
    sampleConversationCount: 150,
    balanceNanoUsd: usdDecimalToNanoUsd('10000.00000000'),
  },
  {
    name: 'bob',
    displayName: 'Marcus Johnson',
    emailVerified: true,
    hasSampleData: false,
    sampleConversationCount: 3,
    balanceNanoUsd: usdDecimalToNanoUsd('0.20000000'),
  },
  {
    name: 'charlie',
    displayName: 'Priya Patel',
    emailVerified: true,
    hasSampleData: false,
    sampleConversationCount: 3,
    balanceNanoUsd: usdDecimalToNanoUsd('0.00000000'),
  },
];

export const TEST_2FA_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

interface BaseTestPersona {
  name: string;
  displayName: string;
  emailVerified: boolean;
  hasSampleData: boolean;
  totpSecret: string | null;
  /**
   * Authoritative starting purchased-wallet balance in nano-USD. Set last by the
   * e2e seed (`setWalletBalance`), overriding the mint's $0.20 welcome credit —
   * so a live AI send (the composer defaults to Smart Model, whose admission hold
   * exceeds the welcome credit) doesn't 402. `0n` deliberately zeroes the welcome
   * credit: the group-billing suite proves owner-funding by keeping the sender
   * broke.
   */
  balanceNanoUsd: bigint;
}

export interface SeededTestPersona extends BaseTestPersona {
  /** Pre-computed username (≤20 chars, unique). Use verbatim when seeding. */
  username: string;
}

/**
 * Default funded purchased-wallet balance ($100) for e2e personas that perform
 * live AI sends. Large enough to clear any admission hold (incl. Smart Model,
 * the composer default).
 */
const DEFAULT_TEST_BALANCE_NANO_USD = usdDecimalToNanoUsd('100.00000000');

export const CORE_TEST_PERSONAS: BaseTestPersona[] = [
  {
    name: 'test-alice',
    displayName: 'Test Alice',
    emailVerified: true,
    hasSampleData: true,
    totpSecret: null,
    // Paid-tier owner/sender across the group, realtime, and billing suites
    // (group-chat-billing.spec.ts requires exactly $100.00 purchased).
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-bob',
    displayName: 'Test Bob',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    // Deliberately broke: group-chat-billing.spec.ts proves owner-funding and
    // free-tier fallthrough by keeping Bob at $0 purchased (its "owner balance
    // exhausted" test asserts ownerRemaining = 0). `0n` zeroes the mint's
    // welcome credit.
    balanceNanoUsd: 0n,
  },
  {
    name: 'test-charlie',
    displayName: 'Test Charlie',
    emailVerified: false,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-dave',
    displayName: 'Test Dave',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  // Dedicated billing test users (isolated to avoid balance state bleeding
  // between tests). displayNames are abbreviated ("Bill" not "Billing") so the
  // normalized username + "_<2-char-project>" fits in varchar(20).
  {
    name: 'test-billing-success',
    displayName: 'Test Bill Success',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-billing-failure',
    displayName: 'Test Bill Failure',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-billing-validation',
    displayName: 'Test Bill Valid',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    // Funded default; the `lowBalancePage` fixture zeroes both wallets inline
    // when a test needs this persona broke.
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-billing-success-2',
    displayName: 'Test Bill OK 2',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-billing-devmode',
    displayName: 'Test Bill Dev',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-billing-token',
    displayName: 'Test Bill Token',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-2fa',
    displayName: 'Test 2FA User',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: TEST_2FA_TOTP_SECRET,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
];

/**
 * Base persona names seeded once per Playwright worker slot, so no two workers
 * of the fully-parallel browser matrix ever contend on one persona's
 * server-side state.
 *
 * Two different contentions are being removed. Personas driven through live
 * chat sends (`test-alice`/`test-bob`/`test-dave`) contend on their **wallet**:
 * a smart-model admission hold reserves ≈ the whole wallet, so a shared wallet
 * supports only ~one in-flight run — the root cause of the chat-turn 402
 * INSUFFICIENT_ADMISSION flood. The 2FA persona contends instead on its
 * **per-user login state**: a spec that submits a deliberately wrong TOTP code
 * charges that user's lockout counter, and a valid code burns a one-shot
 * `totp:used:` replay marker, both of which any concurrent login as the same
 * user inherits.
 *
 * Personas outside this set are per-purpose isolated and reset per test (the
 * `test-billing-*` roster, `lowBalancePage`), so they are deliberately not
 * pooled.
 */
export const POOLED_PERSONA_BASE_NAMES = [
  'test-alice',
  'test-bob',
  'test-dave',
  'test-2fa',
] as const;

// Per-worker isolation pool size ({@link E2E_WORKER_POOL_SIZE}, imported
// above from worker-count.ts). It is the max of the local worker count
// resolveLocalWorkerCount() picks (playwright.config.ts) and CI's 7, so it is
// always ≥ whatever `workers` count actually runs — the `workers ≤ pool`
// invariant. Because the local count is machine-relative (per-CPU registry or
// 45% of cores), the pool — and thus the number of pooled personas seeded — is
// machine-dependent; each machine seeds and runs against its own consistent
// pool. The worker slot `parallelIndex` (0-based, `0..workers-1`) selects the
// copy; slot 0 reuses the un-suffixed persona so existing seed rows and
// `.auth/*` storage-state files are unchanged.

/**
 * Resolve a pooled persona's per-worker base name. Slot 0 — and any persona not
 * in {@link POOLED_PERSONA_BASE_NAMES} — keeps the original name; slots
 * `1..N-1` get a `-w<slot>` suffix. `workerIndex` is taken modulo the pool size
 * so a machine configured with more workers than the pool degrades to partial
 * sharing rather than an out-of-range lookup — keep {@link E2E_WORKER_POOL_SIZE}
 * ≥ the max worker count to guarantee full isolation.
 */
export function pooledPersonaName(baseName: string, workerIndex: number): string {
  if (!(POOLED_PERSONA_BASE_NAMES as readonly string[]).includes(baseName)) return baseName;
  const slot = ((workerIndex % E2E_WORKER_POOL_SIZE) + E2E_WORKER_POOL_SIZE) % E2E_WORKER_POOL_SIZE;
  return slot === 0 ? baseName : `${baseName}-w${String(slot)}`;
}

/**
 * Per-worker isolation copies of the pooled personas (slots `1..N-1`). Each
 * copy is a distinct seeded user with its own OPAQUE credentials, session,
 * wallet and TOTP enrolment, so parallel workers share none of them. Copies
 * carry no sample data (specs seed their own conversations via the `/dev/*`
 * endpoints) and inherit every other field from their source, so the special
 * balances the suites rely on hold per worker and a 2FA copy stays loggable
 * with the shared TOTP secret. The ` W<slot>` displayName keeps each normalized
 * username unique; how many slot digits fit under the `varchar(20)` limit is
 * set by the longest pooled base name once `_w` and the 2-char project code are
 * added, and the length check below throws at load rather than seeding a
 * truncated username.
 */
const WORKER_POOL_TEST_PERSONAS: BaseTestPersona[] = CORE_TEST_PERSONAS.filter((p) =>
  (POOLED_PERSONA_BASE_NAMES as readonly string[]).includes(p.name)
).flatMap((source) =>
  Array.from({ length: E2E_WORKER_POOL_SIZE - 1 }, (_, index) => {
    const slot = index + 1;
    return {
      ...source,
      name: `${source.name}-w${String(slot)}`,
      displayName: `${source.displayName} W${String(slot)}`,
      hasSampleData: false,
    };
  })
);

export const BASE_TEST_PERSONAS: BaseTestPersona[] = [
  ...CORE_TEST_PERSONAS,
  ...WORKER_POOL_TEST_PERSONAS,
];

const USERNAME_MAX_LENGTH = 20;

export const TEST_PERSONAS: SeededTestPersona[] = E2E_PROJECT_NAMES.flatMap((projectName) =>
  BASE_TEST_PERSONAS.map((p) => {
    const baseUsername = p.displayName.trim().toLowerCase().replaceAll(/\s+/g, '_');
    const username = `${baseUsername}_${PROJECT_CODE[projectName]}`;
    /* v8 ignore next 5 -- build-time invariant over the machine-dependent roster (asserted by a test); no roster username exceeds the limit */
    if (username.length > USERNAME_MAX_LENGTH) {
      throw new Error(
        `seed: persona username "${username}" exceeds ${String(USERNAME_MAX_LENGTH)} chars; shorten "${p.displayName}".`
      );
    }
    return {
      ...p,
      name: `${p.name}-${projectName}`,
      username,
    };
  })
);

/**
 * Single mobile-test persona — kept outside the E2E_PROJECT_NAMES cross-product
 * so Maestro flows can hardcode `test-mobile@test.hushbox.ai` without taking a
 * dependency on Playwright project state.
 */
export const MOBILE_TEST_PERSONA: SeededTestPersona = {
  name: 'test-mobile',
  displayName: 'Test Mobile',
  // Username is the shortest legal value (3 chars, ^[a-z][a-z0-9_]{2,19}$).
  // Maestro 2.6.0 spends ~10 s per character on Capacitor WebView inputs on
  // docker-android (UiDevice.pressKeyCode synchronous dispatch — Maestro
  // issue #2718), so trimming the username from 11 chars to 3 saves ~80 s per
  // `inputText ${TEST_USERNAME}` call in mobile-tests/flows.
  username: 'tmu',
  emailVerified: true,
  hasSampleData: true,
  totpSecret: null,
  balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
};

export function testPersonaName(baseName: string, projectName: E2EProjectName): string {
  return `${baseName}-${projectName}`;
}
