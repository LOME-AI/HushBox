import { isAdminRole } from '@hushbox/shared';
import type { AdminRole } from '@hushbox/shared';

/**
 * The comma-separated entries of an admin registry binding, normalized once:
 * trimmed, lowercased, blanks dropped. Both readings below are built on this,
 * so the allowlist and the role map can never disagree about what an entry is
 * or how an address is spelled — a viewer's address that matched one and
 * missed the other would be an authenticated actor with no role, or an
 * operator recipient nothing authenticates.
 */
function normalizedEntries(raw?: string): readonly string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

/**
 * The ONE reading of the `ADMIN_ACTOR_ALLOWLIST` binding.
 *
 * Empty is returned, never thrown — "configured with nobody" is refused at each
 * call site, whose operator context differs (a reachable admin route without
 * Access config is a pipeline defect; a notification fan-out with no recipients
 * is a notifier defect).
 */
export function parseAdminActorAllowlist(raw?: string): ReadonlySet<string> {
  return new Set(normalizedEntries(raw));
}

/**
 * The ONE reading of the `ADMIN_ROLE_MAP` binding: `email=role` pairs over the
 * closed {@link AdminRole} set. An entry naming no role, or a role the set does
 * not carry, is DROPPED rather than defaulted — the Access stage refuses an
 * allowlisted email this map has no entry for, so a malformed entry fails
 * closed as "configured with nobody" instead of quietly granting the fuller
 * role.
 *
 * One of the two bindings the wall admits on; {@link adminAdmittedActors} is
 * the set they yield together.
 *
 * Empty is returned, never thrown, for the reason {@link parseAdminActorAllowlist}
 * returns empty.
 */
export function parseAdminRoleMap(raw?: string): ReadonlyMap<string, AdminRole> {
  const entries = new Map<string, AdminRole>();
  for (const entry of normalizedEntries(raw)) {
    const separator = entry.indexOf('=');
    if (separator === -1) continue;
    const email = entry.slice(0, separator).trim();
    const role = entry.slice(separator + 1).trim();
    if (email === '' || !isAdminRole(role)) continue;
    entries.set(email, role);
  }
  return entries;
}

/**
 * The operator subset of the role map — the audience for everything the plane
 * mails: the op-notification fan-out and the daily audit digest. Derived from
 * the role map rather than the allowlist so a read-only viewer receives no
 * operational mail.
 *
 * A recipient list, and not to be confused with the set of people whose login
 * is legitimate: that second set is {@link adminAdmittedActors}, which carries
 * every role.
 */
export function adminOperatorEmails(roles: ReadonlyMap<string, AdminRole>): readonly string[] {
  return [...roles].filter(([, role]) => role === 'operator').map(([email]) => email);
}

/**
 * The actors the admin wall admits: an address the allowlist carries AND the
 * role map gives a role to. `pipelineAdmin` refuses on either miss, so neither
 * binding's own membership is admission on its own.
 *
 * This is the Access-log auditor's expected-actor set. The wall and that
 * auditor must agree on exactly who is authorized — the auditor's whole job is
 * alerting on an authentication the wall would have refused — so the agreement
 * is one derivation over the same two parsers rather than a second reading
 * that could drift and silence the detector.
 */
export function adminAdmittedActors(
  allowlist: ReadonlySet<string>,
  roles: ReadonlyMap<string, AdminRole>
): ReadonlySet<string> {
  return new Set([...roles.keys()].filter((email) => allowlist.has(email)));
}
