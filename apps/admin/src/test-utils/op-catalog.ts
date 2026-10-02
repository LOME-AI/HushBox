import { ADMIN_OP_CONTRACTS, adminOpCatalogEntry } from '@hushbox/shared';
import type { AdminOpContractName, AdminOpWire, AdminOpsCatalog } from '@hushbox/shared';

/**
 * `GET /admin/ops` catalog entries for REGISTERED ops, projected from
 * `ADMIN_OP_CONTRACTS` rather than restated.
 *
 * A hand-written entry for a real op is a second, uncompared statement of
 * that op's `effectClass`, `inverse` and input fields: an inventory change
 * falsifies it and nothing reds. Deriving the data closes that permanently —
 * a test's own assertion is then what pins the behaviour it cares about, and
 * it fails when the contract stops supporting it.
 *
 * The projection is `adminOpCatalogEntry`, the same function the admin
 * routes serve the catalog with, so a fixture entry cannot drift from what
 * the endpoint emits.
 *
 * For an op that does NOT exist — the unknown-op fallback paths — write the
 * literal entry inline; there is no contract to derive from.
 */
export function opCatalogEntry(name: AdminOpContractName): AdminOpWire {
  return adminOpCatalogEntry(ADMIN_OP_CONTRACTS[name]);
}

/**
 * The catalog envelope a `GET /admin/ops` stub returns, for named ops. The
 * role defaults to `operator` because that is the role every screen under test
 * renders for; a viewer's catalog is built by passing the role explicitly.
 */
export function opCatalog(...names: readonly AdminOpContractName[]): AdminOpsCatalog {
  return { ops: names.map((name) => opCatalogEntry(name)), role: 'operator' };
}
