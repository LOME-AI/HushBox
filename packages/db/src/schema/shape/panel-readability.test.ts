import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';

import * as schema from '../index';

/**
 * The `admin_sql_panel` role is granted SELECT on every table in the schema,
 * including tables that do not exist yet (`ALTER DEFAULT PRIVILEGES`). Panel
 * readability is therefore the default, and a table holding material an
 * operator must not read stays readable unless its own migration revokes it.
 *
 * This registry is that decision, stated per table. `revoked` means the
 * migration chain carries a `REVOKE SELECT` for the table — whether the
 * carve-out is total (`verification_tokens`) or followed by a column-scoped
 * re-grant (`users`, `device_tokens`).
 */
const PANEL_READABILITY: Record<string, 'readable' | 'revoked'> = {
  users: 'revoked',
  verification_tokens: 'revoked',
  device_tokens: 'revoked',
  newsletter_subscribers: 'revoked',

  wallets: 'readable',
  ledger_entries: 'readable',
  usage_records: 'readable',
  llm_completions: 'readable',
  media_generations: 'readable',
  payments: 'readable',
  member_budgets: 'readable',
  conversation_spending: 'readable',
  allowance_spending: 'readable',
  conversations: 'readable',
  conversation_members: 'readable',
  conversation_forks: 'readable',
  messages: 'readable',
  content_items: 'readable',
  epochs: 'readable',
  epoch_members: 'readable',
  // link_auth_hash is a SHA-256 of a secret token: presenting it authenticates nothing.
  shared_links: 'readable',
  shared_messages: 'readable',
  model_catalog: 'readable',
  newsletter_issues: 'readable',
  newsletter_deliveries: 'readable',
  newsletter_webhook_events: 'readable',
  // body_hash digests a request body that carries a chat turn's plaintext.
  idempotency_keys: 'revoked',
  jobs: 'readable',
  admin_audit: 'readable',
  feedback: 'readable',
  custom_instructions: 'readable',
  preferences: 'readable',
  notification_preferences: 'readable',
  service_evidence: 'readable',
  account_deletion_events: 'readable',
  user_acquisition: 'readable',
  terms_acceptances: 'readable',
  banner_config: 'readable',
  banner_dismissals: 'readable',
  public_stats_snapshots: 'readable',
  campaigns: 'readable',
  growth_visitors: 'readable',
  growth_paths: 'readable',
  growth_referrers: 'readable',
  growth_campaign_paths: 'readable',
  growth_geo: 'readable',
  growth_daily_path_reach: 'readable',
  growth_hourly_events: 'readable',
  growth_hourly_funnel: 'readable',
  growth_hourly_product_entry: 'readable',
};

const schemaTableNames = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => value instanceof PgTable)
  .map((table) => getTableConfig(table).name)
  .toSorted((a, b) => a.localeCompare(b));

/** Tables the migration chain revokes panel SELECT on, however it re-grants after. */
const revokedInMigrations = ((): Set<string> => {
  const directory = new URL('../../../drizzle/', import.meta.url);
  const revoked = new Set<string>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql'))) {
    const sql = readFileSync(new URL(file, directory), 'utf8');
    for (const match of sql.matchAll(/REVOKE\s+SELECT\s+ON\s+(\w+)\s+FROM\s+admin_sql_panel/gi)) {
      revoked.add(match[1] ?? '');
    }
  }
  return revoked;
})();

describe('admin SQL panel readability registry', () => {
  it('covers every table in the schema barrel', () => {
    const undeclared = schemaTableNames.filter((name) => PANEL_READABILITY[name] === undefined);
    expect(undeclared).toEqual([]);
  });

  it('declares no table the schema barrel does not export', () => {
    const known = new Set(schemaTableNames);
    const stale = Object.keys(PANEL_READABILITY)
      .filter((name) => !known.has(name))
      .toSorted((a, b) => a.localeCompare(b));
    expect(stale).toEqual([]);
  });

  it('backs every revoked declaration with a REVOKE in the migration chain', () => {
    const declaredRevoked = schemaTableNames.filter(
      (name) => PANEL_READABILITY[name] === 'revoked'
    );
    expect(declaredRevoked.filter((name) => !revokedInMigrations.has(name))).toEqual([]);
  });

  it('declares every table the migration chain revokes', () => {
    const missing = [...revokedInMigrations]
      .filter((name) => PANEL_READABILITY[name] !== 'revoked')
      .toSorted((a, b) => a.localeCompare(b));
    expect(missing).toEqual([]);
  });
});
