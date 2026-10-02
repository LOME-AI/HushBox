import { requireEnv } from './env.js';

import type { Page } from '@playwright/test';

/**
 * Network allowlist over the browser's egress: a request `isRequestAllowed`
 * rejects is aborted and recorded, so a live third party cannot enter the hot
 * path through the browser.
 *
 * The default admission is exact-host and exact-port — a hostname in
 * `ALLOWED_HOSTNAMES` on a port `allowedLocalPorts` assembles from the stack's
 * `HB_*_PORT` env, the same env the Playwright config and the dev scripts
 * read, so a worktree's offset ports stay correct and no port literal lives in
 * this file. A test extends that set for its own page through
 * `allowExternalHosts`.
 *
 * Schemes with no network egress — in-document media such as canvas blobs and
 * decoded images — are admitted outright.
 *
 * No model-provider host is allowlisted: inference is a server-side call, so a
 * provider request from the browser is a defect this guard must catch.
 */
const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);
const ALWAYS_ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['data:', 'blob:']);

/**
 * Ports of the local services the browser legitimately reaches. Read once at
 * module load. `requireEnv` fail-fasts if the stack env wasn't generated —
 * matching the rest of the suite, which assumes `ensure-stack` ran first.
 *
 * - preview/vite: the app origin (`vite preview` serves E2E; vite dev exists
 *   for parity and worktree port-mapping).
 * - api: REST endpoints AND the conversation WebSocket (same host:port,
 *   `ws://` scheme — host-matching covers both).
 * - minio: the R2/S3 emulator; presigned GET URLs are fetched by the browser.
 * - admin: the admin SPA (the admin project's page origin; `vite preview`
 *   serves E2E, vite dev binds the same port under `pnpm dev`); its `/api/*`
 *   vite proxy is also the admin suite's browser-side API origin.
 * - sandbox: the document sandbox origin — the app embeds its renderer pages in
 *   an iframe, and those pages fetch their own assets (config/bundle, Pyodide
 *   wasm/wheels) from the same origin. Without it the sandbox frame is a
 *   non-allowlisted host and the allowlist would abort it.
 */
function allowedLocalPorts(): ReadonlySet<string> {
  return new Set([
    requireEnv('HB_PREVIEW_PORT'),
    requireEnv('HB_VITE_PORT'),
    requireEnv('HB_API_PORT'),
    requireEnv('HB_MINIO_API_PORT'),
    requireEnv('HB_ADMIN_PORT'),
    requireEnv('HB_SANDBOX_PORT'),
  ]);
}

const LOCAL_PORTS = allowedLocalPorts();

/**
 * Whether `hostname` falls under one of the opt-in domains: an exact match or
 * a subdomain. Matched on a leading-dot boundary (`host === domain` or
 * `host.endsWith('.' + domain)`) rather than a naive substring/`includes`, so
 * a look-alike like `evil-myhelcim.com.attacker.com` can never pass.
 */
function hostUnderExtraDomains(hostname: string, extraHosts: ReadonlySet<string>): boolean {
  for (const domain of extraHosts) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/**
 * Decide whether a single request URL is allowed. Pure so the allow/deny
 * decision is testable without a browser. `extraHosts` carries the per-test
 * opt-in extension (see `allowExternalHosts`); an entry there is a domain
 * family matched by suffix (the domain or any subdomain of it), on any port.
 * The default arm is exact-host and exact-port, so suffix matching is the
 * opt-in's property alone.
 */
export function isRequestAllowed(url: string, extraHosts: ReadonlySet<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A URL Playwright can't parse can't be a legitimate egress we recognize.
    return false;
  }
  if (ALWAYS_ALLOWED_PROTOCOLS.has(parsed.protocol)) return true;
  if (hostUnderExtraDomains(parsed.hostname, extraHosts)) return true;
  return ALLOWED_HOSTNAMES.has(parsed.hostname) && LOCAL_PORTS.has(parsed.port);
}

/**
 * Domain families the real-payment billing flow legitimately reaches, and the
 * default `allowExternalHosts` applies when a caller names no hosts of its
 * own. Each entry is matched by suffix (the domain itself or any subdomain —
 * see `hostUnderExtraDomains`), so the whole `*.myhelcim.com` / `*.helcim.com`
 * family is covered: Helcim.js tokenizes the card in-browser (e.g.
 * `secure.myhelcim.com`) and in CI may call other Helcim gateway sub-hosts
 * during tokenization, none of which can be enumerated up front. The Hookdeck
 * webhook relay is server-side (CLI tunnel → localhost:API), but its family is
 * included so a browser-side Hookdeck call (should the flow ever make one) is
 * not a false positive.
 * Listed as family roots only; subdomains are implied by the suffix match.
 * Locally the payment flow runs against a mock Helcim, so these families are
 * reached only in CI and the suite stays strict.
 */
const BILLING_EXTERNAL_HOSTS: readonly string[] = ['myhelcim.com', 'helcim.com', 'hookdeck.com'];

const pageExtraHosts = new WeakMap<Page, Set<string>>();

export function getExtraHosts(page: Page): Set<string> {
  let hosts = pageExtraHosts.get(page);
  if (hosts === undefined) {
    hosts = new Set();
    pageExtraHosts.set(page, hosts);
  }
  return hosts;
}

/**
 * Extend one page's allowlist with the host families that page's test
 * legitimately needs. Defaults to `BILLING_EXTERNAL_HOSTS` when called with no
 * list. Call BEFORE any navigation that could trigger the request (e.g. at the
 * top of the test, before `goto`), because the allowlist route consults this
 * set at request time.
 *
 * This is a sanctioned exception, not an escape hatch: a caller must have an
 * edge the default allowlist cannot express, such as a host outside it or a
 * local origin whose port is assigned at run time rather than by the stack
 * env. Everything else stays strict so a stray live third-party in the hot
 * path fails the test.
 *
 * A test carrying `WEBHOOK_TAG` is opted in for it (see
 * `installNetworkAllowlist`), so it needs no explicit call; a test whose edge
 * that tag does not cover calls this itself.
 */
export function allowExternalHosts(
  page: Page,
  hosts: readonly string[] = BILLING_EXTERNAL_HOSTS
): void {
  const set = getExtraHosts(page);
  for (const host of hosts) set.add(host);
}

/**
 * Tag a test carries to declare that it drives the real Helcim → Hookdeck
 * payment path in CI: a page the allowlist guards under it is opted into
 * `BILLING_EXTERNAL_HOSTS` with no call of its own (see
 * `installNetworkAllowlist`).
 */
export const WEBHOOK_TAG = '@webhook';

export interface NetworkViolation {
  host: string;
  url: string;
}

/**
 * Format the network-allowlist violation message. Distinct from the
 * console/API teardown failure so a live-third-party-in-the-hot-path breach
 * reads unambiguously and points at the sanctioned opt-in for the case the
 * default allowlist cannot express.
 */
export function formatNetworkViolations(
  title: string,
  label: string,
  violations: NetworkViolation[]
): string {
  const lines = violations.map((v) => `  ${v.host} — ${v.url}`);
  return (
    `Blocked non-allowlisted network request(s) during test "${title}" (page "${label}").\n` +
    `The E2E suite may only reach the local dev-stack origins the allowlist ` +
    `assembles, plus any host family this test opted in:\n` +
    `${lines.join('\n')}\n\n` +
    `If a host is legitimate, add it to e2e/helpers/network-allowlist.ts; if this test ` +
    `has an edge the default allowlist cannot express, opt in with allowExternalHosts(page).`
  );
}
