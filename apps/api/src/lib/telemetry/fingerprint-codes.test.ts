import { assertType, describe, expect, it } from 'vitest';

import { FINGERPRINT_CODES, type FingerprintCode } from './fingerprint-codes.js';

describe('FINGERPRINT_CODES registry', () => {
  it('holds every captureError fingerprint code in use as its exact emitted string', () => {
    // The full set is frozen: a rename or addition is a deliberate, visible
    // diff here, and any code emitted at a `captureError` call site must be a
    // member — the registry is the exhaustive source of Sentry fingerprints.
    expect(new Set(Object.values(FINGERPRINT_CODES))).toStrictEqual(
      new Set([
        'cron_unknown_schedule',
        'cron_entry_failed',
        'INTERNAL',
        'job_pass_failed',
        'job_dead_letter',
        'job_completion_write_failed',
        'jobs_stuck',
        'job_lease_timeout',
        'media_gc_delete_failed',
        'workflow_node_defect',
        'workflow_settlement_defect',
        'workflow_run_defect',
        'workflow_cost_circuit_tripped',
        'workflow_infra_unavailable',
        'workflow_rejected_output_absorbed',
        'workflow_refusal_absorbed',
        'workflow_admission_grant_malformed',
        'workflow_predicate_contract_broken',
        'workflow_unregistered_implementation',
        'inference_provider_cost_unavailable',
        'opaque_server_material_unreadable',
        'totp_secret_stranded',
        'model_catalog_retention_list_empty',
        'model_catalog_mass_exclusion',
        'model_projection_invalid',
        'model_descriptor_invalid',
        'model_family_unclassifiable',
        'trial_daily_cap_crossed',
        'admin_ephemeral_effect_failed',
        'admin_op_notification_failed',
        'admin_role_refused',
        'admin_access_enrollment_event',
        'admin_access_unexpected_actor',
        'admin_access_log_page_limit',
        'ledger_conservation_unbalanced',
        'ledger_wallet_balance_drift',
        'wallet_snapshot_audit_failed',
        'wallet_snapshot_seq_ahead',
        'wallet_snapshot_drift',
        'payment_clawback_posted',
        'payment_dispute_surfaced',
        'payment_dispute_unmatched',
        'payment_dispute_orphaned',
        'payment_completed_without_wallet',
        'payment_unresolved_past_verify_window',
        'push_delivery_total_failure',
        'rate_limit_bypassed',
        'dependency_unavailable',
        'backup_stale',
        'backup_lifecycle_drift',
        'backup_audit_unavailable',
        'backup_retention_overdue',
        'backup_retention_unscanned',
        'growth_counter_unavailable',
        'growth_set_overflowed',
        'growth_visitor_mint_capped',
        'growth_registration_start_unavailable',
        'growth_landing_count_clamped',
        'search_provider_auth',
        'search_provider_quota',
        'search_provider_unavailable',
        'search_result_oversize',
        'search_row_oversize',
        'epoch_rotation_superseded',
      ])
    );
  });

  it('single-sources the top-level INTERNAL fingerprint from the shared wire code', () => {
    expect(FINGERPRINT_CODES.internal).toBe('INTERNAL');
  });

  it('types a registered code as FingerprintCode and rejects an unregistered literal', () => {
    assertType<FingerprintCode>(FINGERPRINT_CODES.jobDeadLetter);
    // @ts-expect-error an unregistered literal is not a fingerprint code —
    // this is the typo-proof mechanism: a mistyped code fails to compile.
    assertType<FingerprintCode>('not_a_registered_fingerprint_code');
    expect(true).toBe(true);
  });
});
